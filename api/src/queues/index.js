/*
  Ingest pipeline — staged competing consumers on BullMQ.

        ┌─ upload  (I/O: provider API)            ─┐
  flow ─┼─ embed   (CPU: SigLIP 2, tags, place)    ─┼─► finalize (DB rows, bloom, cleanup)
        └─ faces   (CPU: detect + cluster)         ─┘
  documents: upload + docindex (extract, chunk, embed text) ─► finalize

  Each stage has its own queue so it can be tuned (concurrency, rate limit, retries) and
  scaled independently; any number of worker replicas compete for jobs. The parent
  `finalize` job runs only once its children finish. `faces` is optional: its failure is
  ignored, while `upload`/`embed` failures fail the whole flow.
*/
import { FlowProducer, Queue } from "bullmq";
import { facesEnabled } from "../config.js";
import { createRedis, redis } from "../lib/redis.js";

export const Q = {
  upload: "omni-upload",
  embed: "omni-embed",
  faces: "omni-faces",
  docindex: "omni-docs",
  finalize: "omni-finalize",
};

const connection = createRedis();
export const queues = Object.fromEntries(Object.entries(Q).map(([k, name]) => [k, new Queue(name, { connection })]));
const flow = new FlowProducer({ connection });

const retention = { removeOnComplete: { age: 3600, count: 5000 }, removeOnFail: { age: 7 * 86_400 } };
const stageOpts = {
  upload: { attempts: 5, backoff: { type: "exponential", delay: 3_000 }, failParentOnFailure: true },
  embed: { attempts: 4, backoff: { type: "exponential", delay: 5_000 }, failParentOnFailure: true },
  faces: { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, ignoreDependencyOnFailure: true },
  docindex: { attempts: 3, backoff: { type: "exponential", delay: 5_000 }, failParentOnFailure: true },
};

// BullMQ forbids ':' in custom ids. One flow per (user, content hash) dedupes in-flight uploads.
export const flowId = (userId, fileHash) => `${userId}_${fileHash}`;
const pendingKey = (userId) => `omni:pending:${userId}`;

// Fair share: priority = how many of this user's files are already queued (lower runs first),
// so one user's 500-file batch interleaves with everyone else's instead of blocking them.
export async function enqueueIngest(data) {
  const id = flowId(data.userId, data.fileHash);
  await redis.del(releasedKey(id)); // a new flow for this file releases its own slot once
  const [[, pending]] = await redis.multi().incr(pendingKey(data.userId)).expire(pendingKey(data.userId), 86_400).exec();
  const priority = Math.min(2_097_151, Math.max(1, pending));

  await flow.add({
    name: "finalize",
    queueName: Q.finalize,
    data,
    opts: { jobId: id, priority, attempts: 5, backoff: { type: "exponential", delay: 2_000 }, ...retention },
    // Optional stages are only added when enabled.
    // Documents get text indexing instead of the image stages.
    children: (data.mediaType === "document"
      ? ["upload", "docindex"]
      : ["upload", "embed", ...(facesEnabled ? ["faces"] : [])]
    ).map((stage) => ({
      name: stage,
      queueName: Q[stage],
      data,
      opts: { jobId: `${id}-${stage}`, priority, ...retention, ...stageOpts[stage] },
    })),
  });
  return id;
}

export async function releasePending(userId) {
  const left = await redis.decr(pendingKey(userId));
  if (left < 0) await redis.set(pendingKey(userId), 0, "EX", 86_400);
}

// Exactly once per flow, whichever way it ends (finalize, failure, cancel, or several of them).
const releasedKey = (id) => `omni:released:${id}`;
export async function releaseFlow(userId, fileHash) {
  if (await redis.set(releasedKey(flowId(userId, fileHash)), "1", "EX", 86_400, "NX")) await releasePending(userId);
}

// "completed" | "failed" | "active" | ... | "missing" for the flow's parent (finalize) job.
export async function flowState(userId, fileHash) {
  const parent = await queues.finalize.getJob(flowId(userId, fileHash));
  return parent ? parent.getState() : "missing";
}

export async function stageState(userId, fileHash, stage) {
  const job = await queues[stage].getJob(`${flowId(userId, fileHash)}-${stage}`);
  return job ? job.getState() : "missing";
}

async function stateOf(queue, id) {
  const job = await queue.getJob(id);
  return job ? { job, state: await job.getState() } : { job: null, state: "missing" };
}

export async function jobStatus(id) {
  const parent = await queues.finalize.getJob(id);
  if (!parent) return null;
  const pState = await parent.getState();
  const base = { id, userId: parent.data.userId };

  if (pState === "completed") return { ...base, state: "completed", stage: "done", fileId: parent.returnvalue?.fileId ?? null };

  const [up, emb] = await Promise.all([stateOf(queues.upload, `${id}-upload`), stateOf(queues.embed, `${id}-embed`)]);
  if (pState === "failed") {
    const reason = [up, emb].find((c) => c.state === "failed")?.job?.failedReason || parent.failedReason;
    return { ...base, state: "failed", stage: "failed", error: reason || "Processing failed" };
  }
  const queued = (s) => ["waiting", "prioritized", "delayed", "waiting-children"].includes(s);
  let stage;
  if (pState === "active" || pState === "waiting" || pState === "prioritized") stage = "finalizing";
  else if (up.state === "active") stage = "uploading";
  else if (queued(up.state)) stage = "queued";
  else stage = "indexing";
  return { ...base, state: "active", stage, retrying: (up.job?.attemptsMade || 0) + (emb.job?.attemptsMade || 0) > 0 && !queued(up.state) };
}

const BACKLOG_STATES = ["waiting", "prioritized", "active", "delayed"];
let backlogCache = { at: 0, value: 0 };

export async function queueBacklog(names = Object.keys(Q)) {
  const counts = await Promise.all(names.map((k) => queues[k].getJobCounts(...BACKLOG_STATES)));
  return Object.fromEntries(names.map((k, i) => [k, BACKLOG_STATES.reduce((s, st) => s + (counts[i][st] || 0), 0)]));
}

// Cached for 2s so a burst of uploads doesn't hammer Redis with count queries.
export async function totalBacklog() {
  if (Date.now() - backlogCache.at < 2_000) return backlogCache.value;
  const per = await queueBacklog();
  backlogCache = { at: Date.now(), value: Object.values(per).reduce((a, b) => a + b, 0) };
  return backlogCache.value;
}

export async function closeQueues() {
  await Promise.allSettled([flow.close(), ...Object.values(queues).map((q) => q.close())]);
  // BullMQ doesn't close connections it was handed; without this, short scripts never exit.
  await connection.quit().catch(() => connection.disconnect());
}
