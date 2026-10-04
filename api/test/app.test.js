import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the bits of ioredis the API uses.
vi.mock("../src/lib/redis.js", () => {
  const store = new Map();
  const redis = {
    ping: vi.fn(async () => "PONG"),
    get: vi.fn(async (k) => store.get(k) ?? null),
    set: vi.fn(async (k, v) => store.set(k, v)),
    del: vi.fn(async (...ks) => ks.forEach((k) => store.delete(k))),
    expire: vi.fn(async () => 1),
    hgetall: vi.fn(async () => ({})),
    multi() {
      const ops = [];
      const chain = {
        get: (k) => (ops.push(() => store.get(k) ?? null), chain),
        ttl: () => (ops.push(() => 1_000_000), chain),
        exec: async () => ops.map((op) => [null, op()]),
      };
      return chain;
    },
  };
  return { redis, createRedis: () => redis, ensureBloom: vi.fn(), bloomMightContain: vi.fn(async () => false), bloomAdd: vi.fn() };
});
vi.mock("../src/db/index.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })) },
  query: vi.fn(async () => []),
  one: vi.fn(async () => null),
  PROVIDER_IDS: { gdrive: 1, dropbox: 2 },
  PROVIDER_KEYS: { 1: "gdrive", 2: "dropbox" },
}));
vi.mock("../src/queues/index.js", () => ({
  queues: { finalize: { getJob: vi.fn() } },
  enqueueIngest: vi.fn(),
  flowId: (u, h) => `${u}_${h}`,
  jobStatus: vi.fn(),
  totalBacklog: vi.fn(async () => 0),
  queueBacklog: vi.fn(async () => ({ upload: 3, embed: 1, ocr: 0, finalize: 0 })),
}));
vi.mock("../src/services/ml.js", () => ({
  understandQuery: vi.fn(async () => ({ visual_query: "beach", people: ["Rahul"], places: [], kinds: [], date_from: "2024-03-01", date_to: "2024-03-31", source: "local" })),
  searchImages: vi.fn(async () => ({ results: [] })),
  rerankResults: vi.fn(),
  capabilities: vi.fn(async () => ({ rerank: "local", faces: "local" })),
  deleteFromIndex: vi.fn(),
  mergeFaces: vi.fn(async () => ({ updated: 2 })),
}));
vi.mock("../src/providers/index.js", async (orig) => ({
  ...(await orig()),
  connectedProviders: vi.fn(async () => ["gdrive"]),
}));

const { createApp } = await import("../src/app.js");
const db = await import("../src/db/index.js");
const ml = await import("../src/services/ml.js");
const { createSession } = await import("../src/lib/session.js");

let app;
let cookie;
beforeAll(async () => {
  app = createApp();
  cookie = `omni_sid=${await createSession({ id: "00000000-0000-0000-0000-000000000001", email: "a@b.c", name: "A" })}`;
});

describe("api", () => {
  it("reports health for redis and postgres", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, redis: true, postgres: true });
  });

  it("rejects requests without a session", async () => {
    expect((await request(app).get("/api/providers")).status).toBe(401);
  });

  it("ignores a forged X-User-ID header", async () => {
    expect((await request(app).get("/api/providers").set("X-User-ID", "someone-else")).status).toBe(401);
  });

  it("rejects an unknown session id", async () => {
    expect((await request(app).get("/api/providers").set("Cookie", "omni_sid=nope")).status).toBe(401);
  });

  it("accepts a valid session cookie", async () => {
    const res = await request(app).get("/api/providers").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.providers.map((p) => p.key)).toEqual(["gdrive", "dropbox", "local"]);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).body.user.email).toBe("a@b.c");
  });

  it("blocks state-changing requests without the CSRF header", async () => {
    const res = await request(app).post("/api/auth/logout").set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("keeps dev login disabled unless enabled", async () => {
    const res = await request(app).post("/api/auth/dev").set("X-Requested-With", "omni").send({ email: "x@y.z" });
    expect(res.status).toBe(404);
  });

  it("exposes pipeline status to signed-in users", async () => {
    const res = await request(app).get("/api/system/pipeline").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.backlog.upload).toBe(3);
  });

  it("search: understood filters that match nothing return no results (no vector search)", async () => {
    db.query.mockImplementation(async (sql) => (sql.includes("from people") ? [{ id: "00000000-0000-0000-0000-0000000000aa", name: "Rahul" }] : []));
    const res = await request(app).post("/api/search").set("Cookie", cookie).set("X-Requested-With", "omni").send({ query: "Rahul at the beach in march 2024" });
    expect(res.status).toBe(200);
    expect(res.body.understood).toMatchObject({ visual: "beach", people: ["Rahul"], dateFrom: "2024-03-01" });
    expect(res.body.items).toEqual([]);
    expect(ml.searchImages).not.toHaveBeenCalled();
    db.query.mockImplementation(async () => []);
  });

  it("search: falls back to plain semantic search if understanding is down", async () => {
    ml.understandQuery.mockRejectedValueOnce(new Error("ml down"));
    const res = await request(app).post("/api/search").set("Cookie", cookie).set("X-Requested-With", "omni").send({ query: "sunset" });
    expect(res.status).toBe(200);
    expect(res.body.understood.source).toBe("none");
    expect(ml.searchImages).toHaveBeenCalledWith(expect.objectContaining({ query: "sunset" }));
  });

  it("people: merge validates input and updates the face index", async () => {
    const bad = await request(app).post("/api/people/not-a-uuid/merge").set("Cookie", cookie).set("X-Requested-With", "omni").send({ sources: [] });
    expect(bad.status).toBe(400);
  });

  it("refuses unsigned media links", async () => {
    expect((await request(app).get("/api/media/abc?v=full&exp=9999999999&sig=bad")).status).toBe(403);
  });

  it("logs out and clears the cookie", async () => {
    const res = await request(app).post("/api/auth/logout").set("Cookie", cookie).set("X-Requested-With", "omni");
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"][0]).toMatch(/omni_sid=;.*Max-Age=0/);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(401);
  });
});
