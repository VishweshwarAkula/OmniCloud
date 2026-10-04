// Re-embeds stored files with the ML service's current model (run after changing EMBED_MODEL_NAME).
//   docker compose run --rm api node src/reindex.js          # only files embedded with another model
//   docker compose run --rm api node src/reindex.js --all    # everything
// Jobs go through the normal embed queue at low priority, so live uploads stay fast and the
// autoscaler adds workers / ML replicas while the backlog lasts.
import { facesEnabled } from "./config.js";
import { pool, query } from "./db/index.js";
import { logger } from "./lib/logger.js";
import { redis } from "./lib/redis.js";
import { closeQueues, queues } from "./queues/index.js";
import { modelInfo } from "./services/ml.js";

const all = process.argv.includes("--all");
const { model } = await modelInfo();
const rows = await query(
  `select id from files where status <> 'failed' and provider_file_id is not null
   ${all ? "" : "and embed_model is distinct from $1"} order by created_at desc`,
  all ? [] : [model]
);
const slug = model.replace(/[^A-Za-z0-9]+/g, "-");
await queues.embed.addBulk(
  rows.map((r) => ({
    name: "reindex",
    data: { fileId: r.id },
    opts: {
      jobId: `reindex-${r.id}-${slug}`,
      priority: 100_000, // behind every live upload
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: { age: 7 * 86_400 },
    },
  }))
);
// Files never scanned for faces (uploaded before the feature existed).
let faceJobs = 0;
if (facesEnabled) {
  const unscanned = await query(
    `select id from files where status <> 'failed' and provider_file_id is not null ${all ? "" : "and not faces_scanned"}`
  );
  await queues.faces.addBulk(
    unscanned.map((r) => ({
      name: "reindex",
      data: { fileId: r.id },
      opts: { jobId: `faces-${r.id}${all ? `-${Date.now()}` : ""}`, priority: 100_000, attempts: 3, removeOnComplete: { age: 3600, count: 5000 }, removeOnFail: { age: 7 * 86_400 } },
    }))
  );
  faceJobs = unscanned.length;
}
logger.info({ model, embedJobs: rows.length, faceJobs, all }, "reindex queued");
await Promise.allSettled([closeQueues(), redis.quit(), pool.end()]);
