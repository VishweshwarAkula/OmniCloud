import fs from "node:fs/promises";
import { PROVIDER_IDS, PROVIDER_KEYS, query } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { redis } from "../lib/redis.js";
import { providers, withAccessToken } from "../providers/index.js";
import { queues, releaseFlow } from "../queues/index.js";
import { findByHash } from "./files.js";
import { deleteFromIndex } from "./ml.js";
import { deleteFileAndRecount } from "./people.js";

/*
  Removing files, in three flavours that share one routine:
    removeFile     one file: forget it in OmniCloud (index, faces, row), and with fromCloud delete the cloud copy
    removeFolder   every file under a folder, then (fromCloud) the cloud folders left empty
    cancelUpload   stop an upload's pipeline and undo whatever it already did, cloud copy included

  Order matters, since the cloud, the vector index and Postgres can't share a transaction:
  cloud first (if that fails, nothing changed and the user can retry), then the index, then the
  row + people counts in one DB transaction. Each step tolerates "already gone", so a retry after
  a partial failure finishes the job.
*/
export async function removeFile(row, { fromCloud = false } = {}) {
  if (fromCloud && row.provider_file_id) {
    await withAccessToken(row.user_id, PROVIDER_KEYS[row.provider_id], (at, p) => p.remove(at, row.provider_file_id));
  }
  await deleteFromIndex({ userId: row.user_id, fileHash: row.file_hash }).catch((err) =>
    logger.warn({ err: err.message, fileId: row.id }, "index delete failed")
  );
  await deleteFileAndRecount(row.id);
  await redis.del(`omni:searchctx:${row.user_id}`);
}

// Runs fn over items, `limit` at a time; returns each item's error (or null).
async function pool(items, limit, fn) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]).then(
          () => null,
          (err) => err
        );
      }
    })
  );
  return results;
}

const likePrefix = (folder) => `${folder.replace(/[\\%_]/g, "\\$&")}/%`;

export async function removeFolder(userId, folder, { fromCloud = false } = {}) {
  const rows = await query(
    `select id, user_id, file_hash, provider_id, provider_file_id, folder from files
     where user_id = $1 and (folder = $2 or folder like $3)`,
    [userId, folder, likePrefix(folder)]
  );
  const errors = await pool(rows, 6, (row) => removeFile(row, { fromCloud }));
  const failed = errors.filter(Boolean);
  if (failed.length) logger.warn({ userId, folder, failed: failed.length, err: failed[0].message }, "folder delete: some files failed");

  // Then the cloud folders themselves (see removeEmptyFolders).
  let foldersRemoved = 0;
  if (fromCloud && !failed.length) {
    const perProvider = new Map();
    for (const row of rows) {
      const paths = perProvider.get(row.provider_id) ?? new Set();
      for (const p of ancestors(row.folder, folder.split("/").length)) paths.add(p);
      perProvider.set(row.provider_id, paths);
    }
    for (const [providerId, paths] of perProvider) foldersRemoved += await removeEmptyFolders(userId, PROVIDER_KEYS[providerId], paths);
  }
  return { files: rows.length - failed.length, failed: failed.length, foldersRemoved };
}

// "a/b/c" → ["a", "a/b", "a/b/c"] (from depth `from` on).
const ancestors = (path, from = 1) => {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/")).slice(from - 1);
};

const LIVE = ["waiting", "prioritized", "active", "delayed", "waiting-children"];

// Something OmniCloud knows of still lives (or is about to land) in this cloud folder.
async function folderInUse(userId, key, path) {
  const [row] = await query(
    "select 1 from files where user_id = $1 and provider_id = $2 and (folder = $3 or folder like $4) limit 1",
    [userId, PROVIDER_IDS[key], path, likePrefix(path)]
  );
  if (row) return true;
  const jobs = await queues.upload.getJobs(LIVE);
  return jobs.some((j) => {
    const d = j?.data;
    const f = (d?.folder ?? []).join("/");
    return d?.userId === userId && d.provider === key && !d.uploaded && (f === path || f.startsWith(`${path}/`));
  });
}

/*
  Deepest first, so a parent is checked after its subfolders. A folder is removed only if the
  provider reports it empty AND nothing OmniCloud tracks or is uploading lives under it (an upload
  into a sibling path must not land in a folder that is being deleted). Providers delete folders
  recoverably where they can (Drive: trash). Best effort: failures are logged, never thrown.
*/
async function removeEmptyFolders(userId, key, paths) {
  if (!providers[key]?.removeEmptyFolder) return 0;
  let removed = 0;
  for (const path of [...paths].sort((a, b) => b.split("/").length - a.split("/").length)) {
    try {
      if (await folderInUse(userId, key, path)) continue;
      if (await withAccessToken(userId, key, (at, p) => p.removeEmptyFolder(at, userId, path.split("/")))) removed++;
    } catch (err) {
      logger.warn({ key, path, err: err.message }, "cloud folder cleanup failed");
    }
  }
  return removed;
}

/* ---------------------------------- cancel ---------------------------------- */

const cancelKey = (flowId) => `omni:cancel:${flowId}`;
export const isCancelled = async (userId, fileHash) => Boolean(await redis.exists(cancelKey(`${userId}_${fileHash}`)));

// Uploading the same file again after cancelling it starts clean.
export const clearCancel = (flowId) => redis.del(cancelKey(flowId));

/*
  Undo whatever a cancelled upload already did. Runs more than once by design (at cancel time, and
  again when each stage that was mid-flight stops), so every step is idempotent:
  staged file, pending slot (once per flow), vectors/faces (even without a row: the embed stage
  may have indexed a file whose row is already gone), the row + cloud copy, or, if the upload
  reached the cloud but never got a row, the cloud copy recorded on the job.
*/
export async function cleanupCancelled(d) {
  await fs.unlink(d.tmpPath).catch(() => {});
  await releaseFlow(d.userId, d.fileHash);
  await deleteFromIndex({ userId: d.userId, fileHash: d.fileHash }).catch(() => {});
  const row = await findByHash(d.userId, d.fileHash);
  if (row) await removeFile(row, { fromCloud: true }); // it was only in the cloud because of this upload
  else if (d.uploaded) await withAccessToken(d.userId, d.provider, (at, p) => p.remove(at, d.uploaded.id));
  // Folders this upload created stay only if something else is in them.
  if (d.folder?.length) await removeEmptyFolders(d.userId, d.provider, ancestors(d.folder.join("/")));
}

// Returns "cancelled" | "done" (already finished: nothing to cancel) | "missing".
export async function cancelUpload(userId, flowId) {
  const parent = await queues.finalize.getJob(flowId);
  if (!parent || parent.data.userId !== userId) return "missing";
  const state = await parent.getState();
  if (state === "completed") return "done";
  await redis.set(cancelKey(flowId), "1", "EX", 86_400);
  // The upload stage records the cloud copy on its own job; the parent's data doesn't have it.
  const up = await queues.upload.getJob(`${flowId}-upload`);
  const data = { ...parent.data, ...(up?.data?.uploaded && { uploaded: up.data.uploaded }) };
  if (state === "failed") {
    await cleanupCancelled(data);
    return "cancelled";
  }
  try {
    // Nothing running yet: drop the whole flow and clean up here.
    await parent.remove({ removeChildren: true });
    await cleanupCancelled(data);
  } catch {
    // A stage is running (locked). Workers check the flag before and after every stage, so the
    // running one stops at its next step and its failure handler cleans up.
  }
  return "cancelled";
}
