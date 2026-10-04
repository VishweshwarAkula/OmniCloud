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
