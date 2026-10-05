import crypto from "node:crypto";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "./logger.js";

export function createRedis(opts = {}) {
  const client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, ...opts });
  client.on("error", (err) => logger.error({ err: err.message }, "redis error"));
  return client;
}

export const redis = createRedis();

const BLOOM_KEY = "omni:bloom:files";
let bloomAvailable = config.BLOOM_ENABLED;

// Bloom filter is a fast "definitely new" check in front of the database.
// Managed Redis without the bloom module just falls through to the DB check.
export async function ensureBloom() {
  if (!bloomAvailable) return;
  try {
    await redis.call("BF.RESERVE", BLOOM_KEY, "0.001", "1000000");
  } catch (err) {
    if (/exists/i.test(err.message)) return;
    bloomAvailable = false;
    logger.warn({ err: err.message }, "bloom filter unavailable; using database dedup only");
  }
}

export async function bloomMightContain(member) {
  if (!bloomAvailable) return true;
  try {
    return Number(await redis.call("BF.EXISTS", BLOOM_KEY, member)) === 1;
  } catch {
    return true;
  }
}

export async function bloomAdd(member) {
  if (!bloomAvailable) return;
  await redis.call("BF.ADD", BLOOM_KEY, member).catch(() => {});
}

// Only the holder's token may release the lock (a lock that expired and was re-taken stays put).
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/*
  A lock shared by every process (API, worker replicas): find-or-create and read-modify-write
  sequences that must not interleave across replicas. The TTL only bounds how long a crashed
  holder can block others; keep `fn` well under it.
*/
export async function withLock(key, fn, { ttlMs = 60_000, waitMs = 120_000 } = {}) {
  const token = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  while (!(await redis.set(key, token, "PX", ttlMs, "NX"))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${key}`);
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
  }
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE, 1, key, token).catch(() => {});
  }
}
