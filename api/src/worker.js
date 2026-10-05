/*
  Pipeline worker. Every replica runs consumers for the stages listed in WORKER_QUEUES
  (default: all), each with its own concurrency. Replicas compete for jobs, so throughput
  scales by adding replicas — which the autoscaler does based on queue depth.
*/
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnrecoverableError, Worker } from "bullmq";
import { config } from "./config.js";
import { pool, PROVIDER_KEYS, query } from "./db/index.js";
import { HttpError, ProviderAuthError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { bloomAdd, createRedis, ensureBloom, redis, withLock } from "./lib/redis.js";
import { invalidateUserCaches, withAccessToken } from "./providers/index.js";
import { closeQueues, flowState, Q, queues, releaseFlow, stageState } from "./queues/index.js";
import { findByHash, getFile, metadataPatch, updateFile, upsertFile } from "./services/files.js";
import { detectFaces, embedImage, indexDocument } from "./services/ml.js";
import { facesLock, storeFaces } from "./services/people.js";
import { cleanupCancelled, dropFromIndex, isCancelled, retryIndexDeletes } from "./services/removal.js";

await ensureBloom();

const readStaged = (d) =>
  fs.readFile(d.tmpPath).catch(() => {
    throw new UnrecoverableError("Staged upload is missing");
  });
const storedName = (d) => d.cloudName || `${d.fileHash}${d.ext}`;

// Each stage is idempotent, so retries and duplicate deliveries are harmless.
const processors = {
  async upload(job) {
    const d = job.data;
    const existing = await findByHash(d.userId, d.fileHash);
    if (existing?.provider_file_id) return { fileId: existing.id, skipped: true };
    // The cloud upload and the DB insert can't be one transaction, so the cloud id is recorded on
    // the job the moment the upload succeeds: a retry (crash, DB error) reuses it instead of
    // uploading a second copy, and failure/cancel handlers can still find and remove it.
    let uploaded = d.uploaded;
    if (!uploaded) {
      const buffer = await readStaged(d);
      const res = await withAccessToken(d.userId, d.provider, (at, p) =>
        p.upload(at, { name: storedName(d), folder: d.folder ?? [], mime: d.mime, buffer, userId: d.userId, hash: d.fileHash })
      );
      uploaded = { id: res.id, name: res.name };
      await job.updateData({ ...d, uploaded });
    }
    const row = await upsertFile({
      user_id: d.userId,
      file_hash: d.fileHash,
      provider_id: d.providerId,
      provider_file_id: uploaded.id,
      name: d.originalName,
      mime: d.mime,
      size: d.size,
      status: "indexing",
      // Known now, not at finalize: a file whose indexing fails must still show up as what it is.
      media_type: d.mediaType === "document" ? "document" : "image",
      folder: (d.folder ?? []).join("/"),
    });
    await invalidateUserCaches(d.userId, d.provider);
    // A sibling stage already failed the flow, so finalize will never run: settle the file here
    // (stored in the cloud, shown in the library, just not searchable).
    if ((await flowState(d.userId, d.fileHash)) === "failed") {
      await updateFile(row.id, { status: "ready" });
      await fs.unlink(d.tmpPath).catch(() => {});
    }
    return { fileId: row.id };
  },

  // Documents: extract → chunk → embed text (ML service), instead of the image stages.
  async docindex(job) {
    if (job.name === "reindex") return reindexDocument(job);
    const d = job.data;
    const res = await indexDocument({
      userId: d.userId,
      fileHash: d.fileHash,
      buffer: await readStaged(d),
      mime: d.mime,
      filename: d.originalName || storedName(d),
    });
    return { document: res };
  },

  async embed(job) {
    if (job.name === "reindex") return reindex(job);
    const d = job.data;
    const res = await embedImage({
      userId: d.userId,
      fileHash: d.fileHash,
      buffer: await readStaged(d),
      mime: d.mime,
      name: storedName(d),
      filename: d.originalName,
    });
    return { weaviateId: res.weaviate_id, model: res.model, metadata: res.metadata };
  },

  async faces(job) {
    if (job.name === "reindex") return reindexFaces(job);
    const d = job.data;
    const buffer = await readStaged(d);
    // Clustering reads then writes the face index: serialized per user across all replicas.
    const res = await withLock(facesLock(d.userId), () =>
      detectFaces({ userId: d.userId, fileHash: d.fileHash, buffer, mime: d.mime, name: storedName(d) })
    );
    return { faces: res.faces };
  },

  async finalize(job) {
    const d = job.data;
    const values = await job.getChildrenValues();
    const pick = (queue) => Object.entries(values).find(([k]) => k.includes(`:${queue}:`))?.[1];
    const embedded = pick(Q.embed);
    const faces = pick(Q.faces);
    const doc = pick(Q.docindex)?.document;

    const row = await findByHash(d.userId, d.fileHash);
    if (!row) throw new Error("file row missing after upload stage");
    if (d.mediaType === "document") {
      await updateFile(row.id, {
        status: "ready",
        media_type: "document",
        kind: "document",
        title: doc?.title ?? d.originalName ?? null,
        page_count: doc?.page_count ?? null,
        excerpt: doc?.excerpt ?? null,
      });
    } else {
      await updateFile(row.id, {
        weaviate_id: embedded?.weaviateId ?? null,
        status: "ready",
        ...metadataPatch(embedded?.metadata, embedded?.model),
      });
    }

    if (faces) await storeFaces(d.userId, row.id, faces.faces ?? []);

    // Only fully ingested files enter the bloom filter, so failures stay retryable.
    await bloomAdd(`${d.userId}:${d.fileHash}`);
    await fs.unlink(d.tmpPath).catch(() => {});
    await releaseFlow(d.userId, d.fileHash);
    return { fileId: row.id, kind: embedded?.metadata?.kind ?? null };
  },
};

const storedBytes = (row) =>
  withAccessToken(row.user_id, PROVIDER_KEYS[row.provider_id], async (at, p) =>
    Buffer.from(await (await p.media(at, row.provider_file_id)).arrayBuffer())
  );

// Re-embed an already stored file (e.g. after switching models): bytes come from its provider.
async function reindex(job) {
  const row = await getFile(job.data.fileId);
  if (!row?.provider_file_id) return { skipped: true };
  const buffer = await storedBytes(row);
  const res = await embedImage({
    userId: row.user_id,
    fileHash: row.file_hash,
    buffer,
    mime: row.mime || "image/jpeg",
    name: `${row.file_hash}.img`,
    filename: row.name,
  });
  await updateFile(row.id, { weaviate_id: res.weaviate_id, status: "ready", ...metadataPatch(res.metadata, res.model) });
  return { fileId: row.id, model: res.model };
}

// Index an already stored document (e.g. one whose first indexing failed): bytes come from its provider.
async function reindexDocument(job) {
  const row = await getFile(job.data.fileId);
  if (!row?.provider_file_id) return { skipped: true };
  const doc = await indexDocument({
    userId: row.user_id,
    fileHash: row.file_hash,
    buffer: await storedBytes(row),
    mime: row.mime || "application/octet-stream",
    filename: row.name,
  });
  await updateFile(row.id, { status: "ready", title: doc.title ?? row.name, page_count: doc.page_count ?? null, excerpt: doc.excerpt ?? null });
  return { fileId: row.id, chunks: doc.chunks };
}

// Scan an already stored file for faces (files uploaded before faces were enabled).
async function reindexFaces(job) {
  const row = await getFile(job.data.fileId);
  if (!row?.provider_file_id) return { skipped: true };
  const buffer = await storedBytes(row);
  const res = await withLock(facesLock(row.user_id), () =>
    detectFaces({ userId: row.user_id, fileHash: row.file_hash, buffer, mime: row.mime || "image/jpeg", name: `${row.file_hash}.img` })
  );
  await storeFaces(row.user_id, row.id, res.faces);
  return { fileId: row.id, faces: res.faces.length };
}

const stageSettings = {
  upload: { concurrency: config.UPLOAD_CONCURRENCY },
  embed: { concurrency: config.EMBED_CONCURRENCY },
  faces: { concurrency: config.EMBED_CONCURRENCY },
  docindex: { concurrency: config.DOCINDEX_CONCURRENCY },
  finalize: { concurrency: config.FINALIZE_CONCURRENCY },
};

/*
  A stage failed for good. Sibling stages keep running after the flow fails, and several of them
  can end up here, so every step is idempotent and order-independent:
    - the pending slot is released once per flow (releaseFlow)
    - the staged file is deleted only once the upload stage no longer needs it (otherwise the
      upload stage deletes it itself when it sees the failed flow)
    - an upload that reached the cloud but never got its row is removed from the cloud again
*/
async function onFinalFailure(stage, job) {
  const d = job.data;
  if (job.name === "reindex") return; // standalone
  if (await isCancelled(d.userId, d.fileHash)) return cleanupCancelled(d);
  if (stage === "faces") return; // optional: its failure doesn't fail the flow
  await releaseFlow(d.userId, d.fileHash);
  const row = await findByHash(d.userId, d.fileHash).catch(() => null);
  if (stage === "upload") {
    await fs.unlink(d.tmpPath).catch(() => {});
    await dropFromIndex(d.userId, d.fileHash);
    if (d.uploaded && !row?.provider_file_id) {
      await withAccessToken(d.userId, d.provider, (at, p) => p.remove(at, d.uploaded.id)).catch((err) =>
        logger.warn({ err: err.message, jobId: job.id }, "orphaned cloud copy could not be removed")
      );
    }
    if (row && !row.provider_file_id) await updateFile(row.id, { status: "failed" }).catch(() => {});
    return;
  }
  if (["completed", "failed", "missing"].includes(await stageState(d.userId, d.fileHash, "upload"))) {
    await fs.unlink(d.tmpPath).catch(() => {});
  }
  // Stored in the cloud but not searchable: still show it in the library.
  if (row?.status === "indexing") await updateFile(row.id, { status: "ready" }).catch(() => {});
}

const enabled = (process.env.WORKER_QUEUES || "upload,embed,faces,docindex,finalize").split(",").map((s) => s.trim()).filter((s) => processors[s]);

const workers = enabled.map((stage) => {
  const worker = new Worker(
    Q[stage],
    async (job) => {
      // Cancelled uploads stop at the next stage boundary: before starting, and right after a stage
      // (so a file that just reached the cloud is removed again by the failure handler).
      const cancelled = () => job.name !== "reindex" && isCancelled(job.data.userId, job.data.fileHash);
      if (await cancelled()) throw new UnrecoverableError("Cancelled");
      try {
        const result = await processors[stage](job);
        if (await cancelled()) throw new UnrecoverableError("Cancelled");
        return result;
      } catch (err) {
        // Auth and validation problems won't fix themselves on retry.
        if (err instanceof ProviderAuthError || (err instanceof HttpError && err.status < 500 && err.status !== 429)) {
          throw new UnrecoverableError(err.message);
        }
        throw err;
      }
    },
    { connection: createRedis(), ...stageSettings[stage], name: `${os.hostname()}:${stage}` }
  );
  worker.on("failed", async (job, err) => {
    if (!job) return;
    const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    logger.warn({ stage, jobId: job.id, attempt: job.attemptsMade, final, err: err.message }, "stage failed");
    if (final) await onFinalFailure(stage, job);
  });
  worker.on("completed", (job) => logger.debug({ stage, jobId: job.id }, "stage complete"));
  worker.on("error", (err) => logger.error({ stage, err: err.message }, "worker error"));
  return worker;
});

/*
  Maintenance, every 5 minutes, by one replica at a time (a lock that simply expires). It repairs
  what a crash in the middle of a multi-step operation could leave behind:
    - staged uploads orphaned by a crash (older than a day AND not needed by any live job)
    - index deletes that failed and were queued for retry
    - rows stuck in "indexing" because a worker died inside a failure handler: if their flow is
      over, the file is in the cloud but unsearchable, so it is shown as ready
*/
const LIVE = ["waiting", "prioritized", "active", "delayed", "waiting-children"];

async function sweepUploads() {
  const cutoff = Date.now() - 86_400_000;
  const needed = new Set();
  for (const q of Object.values(queues)) {
    for (const j of await q.getJobs(LIVE)) if (j?.data?.tmpPath) needed.add(path.basename(j.data.tmpPath));
  }
  for (const name of await fs.readdir(config.UPLOAD_DIR).catch(() => [])) {
    if (needed.has(name)) continue;
    const p = path.join(config.UPLOAD_DIR, name);
    const stat = await fs.stat(p).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.unlink(p).catch(() => {});
  }
}

async function settleStuckRows() {
  const rows = await query(
    "select id, user_id, file_hash from files where status = 'indexing' and provider_file_id is not null and created_at < now() - interval '30 minutes'"
  );
  for (const row of rows) {
    if (["failed", "missing", "completed"].includes(await flowState(row.user_id, row.file_hash))) {
      await updateFile(row.id, { status: "ready" });
      logger.info({ fileId: row.id }, "settled a file left indexing by an interrupted flow");
    }
  }
}

async function maintenance() {
  if (!(await redis.set("omni:lock:maintenance", os.hostname(), "PX", 4 * 60_000, "NX"))) return;
  for (const task of [sweepUploads, retryIndexDeletes, settleStuckRows]) {
    await task().catch((err) => logger.warn({ task: task.name, err: err.message }, "maintenance task failed"));
  }
}
const sweepTimer = setInterval(maintenance, 5 * 60_000);

logger.info({ stages: enabled, host: os.hostname(), concurrency: Object.fromEntries(enabled.map((s) => [s, stageSettings[s].concurrency])) }, "worker ready");

// Graceful: stop taking jobs, let in-flight ones finish (compose gives us stop_grace_period).
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, "draining worker");
  clearInterval(sweepTimer);
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([closeQueues(), redis.quit(), pool.end()]);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
