import { HttpError } from "../lib/errors.js";
import { COOKIE, parseCookies, readSession } from "../lib/session.js";

// Identity comes from a server-side session (httpOnly cookie) — never from client-supplied ids.
export async function requireAuth(req, _res, next) {
  try {
    const sid = parseCookies(req.get("cookie"))[COOKIE];
    const session = await readSession(sid);
    if (!session) return next(new HttpError(401, "Sign in required.", "unauthenticated"));
    req.user = session.user;
    req.sessionId = sid;
    next();
  } catch (err) {
    next(err);
  }
}

// CSRF defence for cookie auth: state-changing requests must carry a custom header,
// which browsers only allow cross-origin after a CORS preflight we never approve.
export function requireCsrfHeader(req, _res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-requested-with") !== "omni") return next(new HttpError(403, "Missing CSRF header.", "csrf"));
  next();
}
