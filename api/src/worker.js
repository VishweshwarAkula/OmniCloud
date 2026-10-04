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
import { bloomAdd, createRedis, ensureBloom, redis } from "./lib/redis.js";
import { invalidateUserCaches, withAccessToken } from "./providers/index.js";
import { closeQueues, Q, releasePending } from "./queues/index.js";
import { findByHash, getFile, metadataPatch, updateFile, upsertFile } from "./services/files.js";
import { deleteFromIndex, detectFaces, embedImage, readReceipt } from "./services/ml.js";
import { storeFaces } from "./services/people.js";

await ensureBloom();

const readStaged = (d) =>
  fs.readFile(d.tmpPath).catch(() => {
    throw new UnrecoverableError("Staged upload is missing");
  });
const storedName = (d) => `${d.fileHash}${d.ext}`;

// Each stage is idempotent, so retries and duplicate deliveries are harmless.
const processors = {
  async upload(job) {
    const d = job.data;
    const existing = await findByHash(d.userId, d.fileHash);
    if (existing?.provider_file_id) return { fileId: existing.id, skipped: true };
    const buffer = await readStaged(d);
    const uploaded = await withAccessToken(d.userId, d.provider, (at, p) =>
      p.upload(at, { name: storedName(d), mime: d.mime, buffer, userId: d.userId })
    );
    const row = await upsertFile({
      user_id: d.userId,
      file_hash: d.fileHash,
      provider_id: d.providerId,
      provider_file_id: uploaded.id,
      name: d.originalName,
      mime: d.mime,
      size: d.size,
      status: "indexing",
    });
    await invalidateUserCaches(d.userId, d.provider);
    return { fileId: row.id };
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
    const res = await detectFaces({ userId: d.userId, fileHash: d.fileHash, buffer: await readStaged(d), mime: d.mime, name: storedName(d) });
    return { faces: res.faces };
  },

  async ocr(job) {
    const d = job.data;
    return readReceipt({ buffer: await readStaged(d), mime: d.mime, name: storedName(d) });
  },

  async finalize(job) {
    const d = job.data;
    const values = await job.getChildrenValues();
    const pick = (queue) => Object.entries(values).find(([k]) => k.includes(`:${queue}:`))?.[1];
    const embedded = pick(Q.embed);
    const receipt = pick(Q.ocr);
    const faces = pick(Q.faces);

    const row = await findByHash(d.userId, d.fileHash);
    if (!row) throw new Error("file row missing after upload stage");
    await updateFile(row.id, {
      weaviate_id: embedded?.weaviateId ?? null,
      status: "ready",
      ...metadataPatch(embedded?.metadata, embedded?.model),
    });

    if (faces) await storeFaces(d.userId, row.id, faces.faces ?? []);

    if (receipt?.is_receipt && receipt.total != null) {
      await query(
        `insert into receipts (user_id, file_id, total, currency, vendor, receipt_date, confidence, raw)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (file_id) do update set total = excluded.total, currency = excluded.currency,
           vendor = excluded.vendor, receipt_date = excluded.receipt_date, confidence = excluded.confidence, raw = excluded.raw`,
        [d.userId, row.id, receipt.total, receipt.currency, receipt.vendor, isoDate(receipt.date), receipt.confidence, receipt]
      );
    }

    // Only fully ingested files enter the bloom filter, so failures stay retryable.
    await bloomAdd(`${d.userId}:${d.fileHash}`);
    await fs.unlink(d.tmpPath).catch(() => {});
    await releasePending(d.userId);
    return { fileId: row.id, receipt: Boolean(receipt?.is_receipt) };
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

// Scan an already stored file for faces (files uploaded before faces were enabled).
async function reindexFaces(job) {
  const row = await getFile(job.data.fileId);
  if (!row?.provider_file_id) return { skipped: true };
  const res = await detectFaces({
    userId: row.user_id,
    fileHash: row.file_hash,
    buffer: await storedBytes(row),
    mime: row.mime || "image/jpeg",
    name: `${row.file_hash}.img`,
  });
  await storeFaces(row.user_id, row.id, res.faces);
  return { fileId: row.id, faces: res.faces.length };
}

function isoDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

const stageSettings = {
  upload: { concurrency: config.UPLOAD_CONCURRENCY },
  embed: { concurrency: config.EMBED_CONCURRENCY },
  ocr: { concurrency: config.OCR_CONCURRENCY, limiter: { max: config.OCR_RATE_PER_MINUTE, duration: 60_000 } },
  faces: { concurrency: config.EMBED_CONCURRENCY },
  finalize: { concurrency: config.FINALIZE_CONCURRENCY },
};

// A flow failed for good: clean up so nothing is left half-done.
async function onFinalFailure(stage, job) {
  const d = job.data;
  if (stage === "ocr" || stage === "faces" || job.name === "reindex") return; // optional / standalone
  await fs.unlink(d.tmpPath).catch(() => {});
  await releasePending(d.userId);
  const row = await findByHash(d.userId, d.fileHash).catch(() => null);
  if (stage === "upload") {
    await deleteFromIndex({ userId: d.userId, fileHash: d.fileHash }).catch(() => {});
    if (row && !row.provider_file_id) await updateFile(row.id, { status: "failed" }).catch(() => {});
  } else if (row?.status === "indexing") {
    // Stored in the cloud but not searchable: still show it in the library.
    await updateFile(row.id, { status: "ready" }).catch(() => {});
  }
}

const enabled = (process.env.WORKER_QUEUES || "upload,embed,faces,ocr,finalize").split(",").map((s) => s.trim()).filter((s) => processors[s]);

const workers = enabled.map((stage) => {
  const worker = new Worker(
    Q[stage],
    async (job) => {
      try {
        return await processors[stage](job);
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

// Sweep staged files orphaned by crashes (older than a day). Cheap and idempotent per replica.
async function sweepUploads() {
  const cutoff = Date.now() - 86_400_000;
  for (const name of await fs.readdir(config.UPLOAD_DIR).catch(() => [])) {
    const p = path.join(config.UPLOAD_DIR, name);
    const stat = await fs.stat(p).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.unlink(p).catch(() => {});
  }
}
const sweepTimer = setInterval(sweepUploads, 3_600_000);

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
