import crypto from "node:crypto";
import { config } from "../config.js";

function deriveKey(raw) {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const b64 = Buffer.from(trimmed, "base64");
  if (b64.length === 32) return b64;
  // Any other string: stretch it deterministically to 32 bytes.
  return crypto.createHash("sha256").update(trimmed).digest();
}

const KEY = deriveKey(config.TOKEN_ENC_KEY);
const PREFIX = "v1:";

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64url");
}

// Values without the prefix are legacy plaintext tokens and are returned unchanged.
export function decrypt(value) {
  if (!value?.startsWith(PREFIX)) return value;
  const buf = Buffer.from(value.slice(PREFIX.length), "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
