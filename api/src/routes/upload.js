import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { asyncRoute, HttpError } from "../lib/errors.js";
import { bloomMightContain, redis } from "../lib/redis.js";
import { PROVIDER_IDS } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { connectedProviders, getProvider } from "../providers/index.js";
import { findByHash, serializeFile } from "../services/files.js";
import { cancelUpload, clearCancel } from "../services/removal.js";
import { enqueueIngest, flowId, jobStatus, queues, totalBacklog } from "../queues/index.js";

fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

const IMAGE_TYPES = /^image\/(jpeg|png|gif|webp|bmp|heic|heif|avif|tiff)$/;
// Browsers often send documents as application/octet-stream, so documents are recognised by extension.
const DOC_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
};
const docMime = (name) => DOC_TYPES[path.extname(name || "").toLowerCase()];

// Names that are safe in every provider (Drive, Dropbox, Koofr WebDAV, pCloud).
const cleanName = (s) =>
  String(s || "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
    .replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_")
    .trim()
    .replace(/^\.+$/, "")
    .slice(0, 120);
// "Trips/Goa 2024" (from a folder upload) → ["Trips", "Goa 2024"]; at most 10 levels.
export const folderPath = (raw) => String(raw || "").split(/[\\/]+/).map(cleanName).filter(Boolean).slice(0, 10);

const upload = multer({
  storage: multer.diskStorage({
    destination: config.UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  defParamCharset: "utf8", // non-ASCII file names arrive intact (busboy defaults to latin1)
  limits: { fileSize: Math.max(config.MAX_UPLOAD_MB, config.MAX_DOC_MB) * 1024 * 1024, files: config.MAX_FILES_PER_UPLOAD },
  fileFilter: (_req, file, cb) => cb(null, IMAGE_TYPES.test(file.mimetype) || Boolean(docMime(file.originalname))),
});

const limiter = rateLimit({
  windowMs: 60_000,
  limit: config.UPLOAD_RATE_PER_MINUTE,
  keyGenerator: (req) => req.user.id,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

const router = Router();

router.post(
  "/upload",
  requireAuth,
  limiter,
  upload.array("files"),
  asyncRoute(async (req, res) => {
    const files = req.files || [];
    const cleanup = (f) => fs.promises.unlink(f.path).catch(() => {});
    const provider = String(req.body.provider || "gdrive");
    const folder = folderPath(req.body.folder);
    try {
      const { label } = getProvider(provider);
      if (!(await connectedProviders(req.user.id)).includes(provider)) {
        throw new HttpError(409, `Connect ${label} before uploading.`, "provider_not_connected");
      }
      if (!files.length) throw new HttpError(400, "No supported images or documents in the request.", "no_files");
      // Backpressure: shed load before staging more files than the workers can drain.
      if ((await totalBacklog()) > config.MAX_QUEUE_BACKLOG) {
        res.set("Retry-After", "30");
        throw new HttpError(503, "The pipeline is busy. Please retry in a moment.", "backpressure");
      }
    } catch (err) {
      await Promise.all(files.map(cleanup));
      throw err;
    }

    const results = await Promise.all(
      files.map(async (file) => {
        const isDoc = !IMAGE_TYPES.test(file.mimetype) && Boolean(docMime(file.originalname));
        if (!isDoc && file.size > config.MAX_UPLOAD_MB * 1024 * 1024) {
          await cleanup(file);
          return { name: file.originalname, status: "rejected", error: `Images are limited to ${config.MAX_UPLOAD_MB} MB.` };
        }
        const fileHash = await sha256File(file.path);
        const member = `${req.user.id}:${fileHash}`;

        // Bloom says "definitely new" for most uploads, so the DB is only consulted on a maybe.
        if (await bloomMightContain(member)) {
          const existing = await findByHash(req.user.id, fileHash);
          if (existing && existing.status !== "failed") {
            await cleanup(file);
            return { name: file.originalname, status: "duplicate", fileHash, file: serializeFile(existing) };
          }
        }

        const jobId = flowId(req.user.id, fileHash);
        // Check-then-enqueue must not interleave for the same file (two tabs, or the same file
        // twice in one batch): the loser would bump the pending count for a flow BullMQ dedupes.
        const claim = `omni:enq:${jobId}`;
        if (!(await redis.set(claim, "1", "PX", 30_000, "NX"))) {
          await cleanup(file);
          return { name: file.originalname, status: "queued", fileHash, jobId };
        }
        try {
          const prior = await queues.finalize.getJob(jobId);
          if (prior) {
            const state = await prior.getState();
            if (state === "completed" || state === "failed") await prior.remove({ removeChildren: true });
            else {
              await cleanup(file);
              return { name: file.originalname, status: "queued", fileHash, jobId };
            }
          }

          await clearCancel(jobId);
          await enqueueIngest({
            userId: req.user.id,
            provider,
            providerId: PROVIDER_IDS[provider],
            tmpPath: file.path,
            originalName: file.originalname,
            ext: path.extname(file.originalname).toLowerCase().slice(0, 10),
            mime: isDoc ? docMime(file.originalname) : file.mimetype,
            mediaType: isDoc ? "document" : "image",
            // Stored under its own name (and folder), so the cloud copy stays usable without OmniCloud.
            cloudName: cleanName(file.originalname) || `${fileHash}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`,
            folder,
            size: file.size,
            fileHash,
          });
        } finally {
          await redis.del(claim);
        }
        return { name: file.originalname, status: "queued", fileHash, jobId };
      })
    );

    res.status(202).json({ results });
  })
);

router.get(
  "/jobs/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const status = await jobStatus(req.params.id);
    if (!status || status.userId !== req.user.id) throw new HttpError(404, "Job not found.");
    const { userId: _owner, ...publicStatus } = status;
    res.json(publicStatus);
  })
);

// Cancel uploads already handed to the server (one or a whole batch). Anything they already did,
// including the copy in the cloud, is undone. Finished uploads are left alone ("done").
router.post(
  "/jobs/cancel",
  requireAuth,
  asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === "string").slice(0, 2000) : [];
    if (!ids.length) throw new HttpError(400, "No uploads to cancel.");
    const own = ids.filter((id) => id.startsWith(`${req.user.id}_`));
    const results = {};
    for (const id of own) results[id] = await cancelUpload(req.user.id, id);
    res.json({ results });
  })
);

export default router;
