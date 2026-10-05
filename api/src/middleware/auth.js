import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { getOwner } from "../lib/owner.js";

// No login: this is a single-user app bound to 127.0.0.1, so every request is the owner.
export async function requireAuth(req, _res, next) {
  try {
    req.user = await getOwner();
    next();
  } catch (err) {
    next(err);
  }
}

// Without login, the two things standing between a malicious website and this app are:
//  1. Host check — blocks DNS rebinding (evil.example resolving to 127.0.0.1).
//  2. CSRF header — browsers only send custom headers cross-origin after a CORS preflight we never approve.
const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", new URL(config.PUBLIC_URL).hostname]);

export function requireLocalHost(req, _res, next) {
  const host = (req.get("host") || "").replace(/:\d+$/, "").toLowerCase();
  if (!allowedHosts.has(host)) return next(new HttpError(403, "This app only accepts requests to localhost.", "bad_host"));
  next();
}

export function requireCsrfHeader(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-requested-with") !== "omni") return next(new HttpError(403, "Missing CSRF header.", "csrf"));
  next();
}
