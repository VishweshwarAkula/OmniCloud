import crypto from "node:crypto";
import { config } from "../config.js";

const HOUR = 3600;

function sign(payload) {
  return crypto.createHmac("sha256", config.URL_SIGNING_SECRET).update(payload).digest("base64url");
}

// Expiry is bucketed to the hour (at least 15 min ahead) so the same file yields
// the same URL for a while — that lets the browser cache images across page loads.
export function mediaUrl(fileId, variant = "full", now = Date.now()) {
  const minExp = Math.floor(now / 1000) + 15 * 60;
  const exp = Math.ceil(minExp / HOUR) * HOUR;
  const sig = sign(`${fileId}.${variant}.${exp}`);
  return `/api/media/${encodeURIComponent(fileId)}?v=${variant}&exp=${exp}&sig=${sig}`;
}

export function verifyMedia({ fileId, variant, exp, sig }, now = Date.now()) {
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum * 1000 < now || typeof sig !== "string") return false;
  const expected = Buffer.from(sign(`${fileId}.${variant}.${expNum}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}
