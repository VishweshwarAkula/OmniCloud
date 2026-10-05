import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory ioredis: enough of its API for the real lib/redis.js helpers to run unmodified.
vi.mock("ioredis", () => {
  const kv = new Map();
  const sets = new Map();
  class Redis {
    on() {}
    async get(k) {
      return kv.get(k) ?? null;
    }
    async set(k, v, ...opts) {
      if (opts.includes("NX") && kv.has(k)) return null;
      kv.set(k, String(v));
      return "OK";
    }
    async del(...ks) {
      ks.forEach((k) => kv.delete(k));
    }
    async incr(k) {
      const n = Number(kv.get(k) ?? 0) + 1;
      kv.set(k, String(n));
      return n;
    }
    async eval(_script, _n, k, token) {
      if (kv.get(k) !== token) return 0;
      kv.delete(k);
      return 1;
    }
    async sadd(k, v) {
      (sets.get(k) ?? sets.set(k, new Set()).get(k)).add(v);
    }
    async smembers(k) {
      return [...(sets.get(k) ?? [])];
    }
    async srem(k, v) {
      sets.get(k)?.delete(v);
    }
  }
  return { Redis, __reset: () => (kv.clear(), sets.clear()) };
});
vi.mock("../src/db/index.js", () => ({ query: vi.fn(async () => []), one: vi.fn(), pool: {}, PROVIDER_IDS: { gdrive: 1 }, PROVIDER_KEYS: { 1: "gdrive" } }));
vi.mock("../src/services/ml.js", () => ({ deleteFromIndex: vi.fn() }));
vi.mock("../src/services/files.js", () => ({ findByHash: vi.fn(async () => null) }));
vi.mock("../src/services/people.js", () => ({ deleteFileAndRecount: vi.fn() }));
vi.mock("../src/queues/index.js", () => ({ queues: {}, releaseFlow: vi.fn(), flowState: vi.fn(async () => "missing") }));

const { __reset } = await import("ioredis");
const { bumpGen, genKey, redis, withLock } = await import("../src/lib/redis.js");
const ml = await import("../src/services/ml.js");
const files = await import("../src/services/files.js");
const queues = await import("../src/queues/index.js");
const { dropFromIndex, retryIndexDeletes } = await import("../src/services/removal.js");

beforeEach(() => {
  __reset();
  vi.clearAllMocks();
});

describe("generation-tagged caches", () => {
  it("a reader that loaded data before an invalidation can't put the stale value back", async () => {
    const before = await genKey("omni:at:gdrive:u1"); // a token refresh starts…
    await bumpGen("omni:at:gdrive:u1"); // …the account is reconnected meanwhile…
    await redis.set(before, "old-account-token"); // …and the refresh finishes late
    expect(await redis.get(await genKey("omni:at:gdrive:u1"))).toBeNull();
  });
});

describe("withLock", () => {
  it("runs critical sections one at a time", async () => {
    const order = [];
    const section = (id) => async () => {
      order.push(`${id}:in`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${id}:out`);
    };
    await Promise.all([withLock("omni:lock:t", section("a")), withLock("omni:lock:t", section("b"))]);
    expect(order[1]).toBe(`${order[0][0]}:out`); // the first holder finished before the second entered
  });
});

describe("index delete retries", () => {
  it("queues a failed delete and retries it later", async () => {
    ml.deleteFromIndex.mockRejectedValueOnce(new Error("ml down"));
    await dropFromIndex("u1", "h1");
    expect(await redis.smembers("omni:index-delete-retry")).toHaveLength(1);

    ml.deleteFromIndex.mockResolvedValueOnce({});
    await retryIndexDeletes();
    expect(ml.deleteFromIndex).toHaveBeenLastCalledWith({ userId: "u1", fileHash: "h1" });
    expect(await redis.smembers("omni:index-delete-retry")).toHaveLength(0);
  });

  it("never deletes the index of a file uploaded again since", async () => {
    ml.deleteFromIndex.mockRejectedValueOnce(new Error("ml down"));
    await dropFromIndex("u1", "h2");
    files.findByHash.mockResolvedValueOnce({ id: "f2" }); // re-uploaded: a row exists again
    await retryIndexDeletes();
    expect(ml.deleteFromIndex).toHaveBeenCalledTimes(1); // only the original failed attempt
    expect(await redis.smembers("omni:index-delete-retry")).toHaveLength(0);

    ml.deleteFromIndex.mockRejectedValueOnce(new Error("ml down"));
    await dropFromIndex("u1", "h3");
    queues.flowState.mockResolvedValueOnce("active"); // re-upload in flight, no row yet
    await retryIndexDeletes();
    expect(ml.deleteFromIndex).toHaveBeenCalledTimes(2);
  });
});
