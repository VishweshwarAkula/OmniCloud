import crypto from "node:crypto";
import { config, secureCookies } from "../config.js";
import { redis } from "./redis.js";

export const COOKIE = "omni_sid";
const TTL = Math.round(config.SESSION_TTL_DAYS * 86_400);
// Only a hash of the session id is stored, so a Redis dump can't be replayed as cookies.
const key = (sid) => `omni:sess:${crypto.createHash("sha256").update(sid).digest("hex")}`;

export async function createSession(user) {
  const sid = crypto.randomBytes(32).toString("base64url");
  await redis.set(key(sid), JSON.stringify({ user, iat: Date.now() }), "EX", TTL);
  return sid;
}

// Sliding expiry: refresh the TTL once it has run half way down.
export async function readSession(sid) {
  if (!sid || sid.length > 100) return null;
  const k = key(sid);
  const [raw, ttl] = await redis.multi().get(k).ttl(k).exec().then((r) => r.map(([, v]) => v));
  if (!raw) return null;
  if (ttl > 0 && ttl < TTL / 2) await redis.expire(k, TTL);
  return JSON.parse(raw);
}

export async function destroySession(sid) {
  if (sid) await redis.del(key(sid));
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(value, maxAge) {
  return [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`, secureCookies && "Secure"]
    .filter(Boolean)
    .join("; ");
}

export const setSessionCookie = (res, sid) => res.append("Set-Cookie", cookie(sid, TTL));
export const clearSessionCookie = (res) => res.append("Set-Cookie", cookie("", 0));
