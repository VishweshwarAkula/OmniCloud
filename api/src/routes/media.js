import { Readable } from "node:stream";
import { Router } from "express";
import { asyncRoute, HttpError } from "../lib/errors.js";
import { verifyMedia } from "../lib/signedUrl.js";
import { PROVIDER_KEYS } from "../db/index.js";
import { withAccessToken } from "../providers/index.js";
import { getFile } from "../services/files.js";

const router = Router();

// Authorised by an HMAC-signed, expiring URL so plain <img src> works without
// leaking identity in query strings. Content is immutable per hash, so ETags let
// the browser revalidate without touching the provider at all.
router.get(
  "/media/:fileId",
  asyncRoute(async (req, res) => {
    const { fileId } = req.params;
    const variant = req.query.v === "thumb" ? "thumb" : "full";
    if (!verifyMedia({ fileId, variant, exp: req.query.exp, sig: req.query.sig })) {
      throw new HttpError(403, "Link expired or invalid.");
    }

    const row = await getFile(fileId);
    if (!row?.provider_file_id) throw new HttpError(404, "File not found.");

    const etag = `"${row.file_hash.slice(0, 32)}-${variant}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    if (req.get("if-none-match") === etag) return res.status(304).end();

    const upstream = await withAccessToken(row.user_id, PROVIDER_KEYS[row.provider_id], (at, p) =>
      variant === "thumb" ? p.thumbnail(at, row.provider_file_id) : p.media(at, row.provider_file_id)
    );

    res.setHeader("Content-Type", upstream.headers.get("content-type")?.startsWith("image/") ? upstream.headers.get("content-type") : row.mime || "application/octet-stream");
    const length = upstream.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);
    res.setHeader("Content-Disposition", `inline; filename="${(row.name || "image").replace(/["\\\r\n]/g, "_")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");

    Readable.fromWeb(upstream.body)
      .on("error", (err) => {
        req.log.warn({ err: err.message }, "media stream aborted");
        res.destroy(err);
      })
      .pipe(res);
  })
);

export default router;
