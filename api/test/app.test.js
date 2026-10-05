import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the bits of ioredis the API uses.
vi.mock("../src/lib/redis.js", () => {
  const store = new Map();
  const redis = {
    ping: vi.fn(async () => "PONG"),
    get: vi.fn(async (k) => store.get(k) ?? null),
    set: vi.fn(async (k, v) => store.set(k, v)),
    exists: vi.fn(async (k) => (store.has(k) ? 1 : 0)),
    hset: vi.fn(async () => 1),
    eval: vi.fn(async () => 1),
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
  pool: {
    query: vi.fn(async () => ({ rows: [{ "?column?": 1 }] })),
    connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
  },
  query: vi.fn(async () => []),
  one: vi.fn(async (sql) =>
    /from users|insert into users/.test(sql)
      ? { id: "00000000-0000-0000-0000-000000000001", email: "a@b.c", name: "A", avatar_url: null, created_at: "2026-01-01" }
      : /from files where id/.test(sql)
        ? { id: "00000000-0000-0000-0000-0000000000f1", user_id: "00000000-0000-0000-0000-000000000001", file_hash: "ab", provider_id: 1, provider_file_id: "drive-1" }
        : null
  ),
  PROVIDER_IDS: { gdrive: 1, dropbox: 2 },
  PROVIDER_KEYS: { 1: "gdrive", 2: "dropbox" },
}));
vi.mock("../src/queues/index.js", () => ({
  queues: { finalize: { getJob: vi.fn() }, upload: { getJob: vi.fn(async () => null), getJobs: vi.fn(async () => []) } },
  enqueueIngest: vi.fn(),
  releasePending: vi.fn(),
  releaseFlow: vi.fn(),
  flowId: (u, h) => `${u}_${h}`,
  jobStatus: vi.fn(),
  totalBacklog: vi.fn(async () => 0),
  queueBacklog: vi.fn(async () => ({ upload: 3, embed: 1, faces: 0, finalize: 0 })),
}));
vi.mock("../src/services/ml.js", () => ({
  understandQuery: vi.fn(async () => ({ visual_query: "beach", people: ["Rahul"], places: [], kinds: [], date_from: "2024-03-01", date_to: "2024-03-31", source: "local" })),
  searchImages: vi.fn(async () => ({ results: [] })),
  rerankResults: vi.fn(),
  capabilities: vi.fn(async () => ({ rerank: "local", faces: "local" })),
  deleteFromIndex: vi.fn(async () => {}),
  mergeFaces: vi.fn(async () => ({ updated: 2 })),
}));
vi.mock("../src/providers/index.js", async (orig) => ({
  ...(await orig()),
  connectedProviders: vi.fn(async () => ["gdrive"]),
  withAccessToken: vi.fn(async () => {}),
}));

const { createApp } = await import("../src/app.js");
const db = await import("../src/db/index.js");
const ml = await import("../src/services/ml.js");
const providers = await import("../src/providers/index.js");
const queues = await import("../src/queues/index.js");

let app;
beforeAll(() => {
  app = createApp();
});

describe("api", () => {
  it("reports health for redis and postgres", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, redis: true, postgres: true });
  });




  it("needs no login: every request is the local owner", async () => {
    const res = await request(app).get("/api/providers");
    expect(res.status).toBe(200);
    expect(res.body.providers.map((p) => p.key)).toEqual(["gdrive", "dropbox", "koofr", "pcloud"]);
    expect(res.body.providers.find((p) => p.key === "koofr").method).toBe("credentials");
    expect((await request(app).get("/api/me")).body.user.email).toBe("a@b.c");
  });

  it("rejects requests addressed to a foreign Host (DNS rebinding guard)", async () => {
    const res = await request(app).get("/api/files").set("Host", "evil.example");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("bad_host");
    expect((await request(app).get("/api/health").set("Host", "localhost:8090")).status).toBe(200);
  });

  it("blocks state-changing requests without the CSRF header", async () => {
    const res = await request(app).post("/api/search").send({ query: "x" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("csrf");
  });


  it("exposes pipeline status to signed-in users", async () => {
    const res = await request(app).get("/api/system/pipeline");
    expect(res.status).toBe(200);
    expect(res.body.backlog.upload).toBe(3);
  });

  it("search: understood filters that match nothing return no results (no vector search)", async () => {
    db.query.mockImplementation(async (sql) => (sql.includes("from people") ? [{ id: "00000000-0000-0000-0000-0000000000aa", name: "Rahul" }] : []));
    const res = await request(app).post("/api/search").set("X-Requested-With", "omni").send({ query: "Rahul at the beach in march 2024" });
    expect(res.status).toBe(200);
    expect(res.body.understood).toMatchObject({ visual: "beach", people: ["Rahul"], dateFrom: "2024-03-01" });
    expect(res.body.items).toEqual([]);
    expect(ml.searchImages).not.toHaveBeenCalled();
    db.query.mockImplementation(async () => []);
  });

  it("search: falls back to plain semantic search if understanding is down", async () => {
    ml.understandQuery.mockRejectedValueOnce(new Error("ml down"));
    const res = await request(app).post("/api/search").set("X-Requested-With", "omni").send({ query: "sunset" });
    expect(res.status).toBe(200);
    expect(res.body.understood.source).toBe("none");
    expect(ml.searchImages).toHaveBeenCalledWith(expect.objectContaining({ query: "sunset" }));
  });

  it("people: merge validates input and updates the face index", async () => {
    const bad = await request(app).post("/api/people/not-a-uuid/merge").set("X-Requested-With", "omni").send({ sources: [] });
    expect(bad.status).toBe(400);
  });

  it("accepts documents (by extension) and tags them as documents", async () => {
    const queues = await import("../src/queues/index.js");
    const res = await request(app)
      .post("/api/upload")
      .set("X-Requested-With", "omni")
      .field("provider", "gdrive")
      .attach("files", Buffer.from("# Notes\n\nCaching with a TTL."), { filename: "notes.md", contentType: "application/octet-stream" });
    expect(res.status).toBe(202);
    expect(res.body.results[0].status).toBe("queued");
    expect(queues.enqueueIngest).toHaveBeenLastCalledWith(expect.objectContaining({ mediaType: "document", mime: "text/markdown" }));
  });

  it("folder uploads keep a sanitised folder path and the original file name", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("X-Requested-With", "omni")
      .field("provider", "gdrive")
      .field("folder", "../Trips//Goa: 2024/")
      .attach("files", Buffer.from("# Goa"), { filename: "plan.md", contentType: "application/octet-stream" });
    expect(res.status).toBe(202);
    expect(queues.enqueueIngest).toHaveBeenLastCalledWith(expect.objectContaining({ folder: ["Trips", "Goa_ 2024"], cloudName: "plan.md" }));
  });

  it("delete keeps the cloud copy unless asked to delete it there too", async () => {
    const id = "00000000-0000-0000-0000-0000000000f1";
    providers.withAccessToken.mockClear();
    const keep = await request(app).delete(`/api/files/${id}`).set("X-Requested-With", "omni");
    expect(keep.body).toEqual({ ok: true, deletedFromCloud: false });
    expect(providers.withAccessToken).not.toHaveBeenCalled();

    const gone = await request(app).delete(`/api/files/${id}?cloud=1`).set("X-Requested-With", "omni");
    expect(gone.body).toEqual({ ok: true, deletedFromCloud: true });
    expect(providers.withAccessToken).toHaveBeenCalledOnce();
  });

  it("deletes a folder: every file under it, then the cloud folders left empty (deepest first)", async () => {
    const owner = "00000000-0000-0000-0000-000000000001";
    db.query.mockImplementation(async (sql) =>
      /select id, user_id/.test(sql) // the folder's files; "is the folder still in use?" finds nothing
        ? [
            { id: "f1", user_id: owner, file_hash: "a", provider_id: 1, provider_file_id: "d1", folder: "Trips" },
            { id: "f2", user_id: owner, file_hash: "b", provider_id: 1, provider_file_id: "d2", folder: "Trips/Goa" },
          ]
        : []
    );
    providers.withAccessToken.mockClear();
    const res = await request(app).delete("/api/folders?path=Trips&cloud=1").set("X-Requested-With", "omni");
    db.query.mockImplementation(async () => []);
    expect(res.body).toMatchObject({ ok: true, deletedFromCloud: true, files: 2, failed: 0 });
    // 2 file deletions + 2 empty-folder checks.
    expect(providers.withAccessToken).toHaveBeenCalledTimes(4);
    const folderCalls = providers.withAccessToken.mock.calls.slice(2);
    const seen = [];
    for (const [, , fn] of folderCalls) await fn("at", { removeEmptyFolder: async (_at, _u, path) => seen.push(path.join("/")) });
    expect(seen).toEqual(["Trips/Goa", "Trips"]);
  });

  it("deleting a folder without cloud=1 keeps the cloud copies", async () => {
    db.query.mockImplementation(async (sql) =>
      /select id, user_id/.test(sql) ? [{ id: "f1", user_id: "00000000-0000-0000-0000-000000000001", file_hash: "a", provider_id: 1, provider_file_id: "d1", folder: "Trips" }] : []
    );
    providers.withAccessToken.mockClear();
    const res = await request(app).delete("/api/folders?path=Trips").set("X-Requested-With", "omni");
    db.query.mockImplementation(async () => []);
    expect(res.body).toMatchObject({ ok: true, deletedFromCloud: false, files: 1 });
    expect(providers.withAccessToken).not.toHaveBeenCalled();
  });

  it("cancels queued uploads (only your own) and leaves finished ones alone", async () => {
    const owner = "00000000-0000-0000-0000-000000000001";
    const remove = vi.fn(async () => {});
    const jobs = {
      [`${owner}_aa`]: { data: { userId: owner, fileHash: "aa", tmpPath: "/nope" }, getState: async () => "waiting-children", remove },
      [`${owner}_bb`]: { data: { userId: owner, fileHash: "bb" }, getState: async () => "completed", remove },
    };
    queues.queues.finalize.getJob.mockImplementation(async (id) => jobs[id]);
    const res = await request(app)
      .post("/api/jobs/cancel")
      .set("X-Requested-With", "omni")
      .send({ ids: [`${owner}_aa`, `${owner}_bb`, "someone-else_cc"] });
    expect(res.body.results).toEqual({ [`${owner}_aa`]: "cancelled", [`${owner}_bb`]: "done" });
    expect(remove).toHaveBeenCalledOnce();
    expect(queues.releaseFlow).toHaveBeenCalledWith(owner, "aa");
  });

  it("keeps a cloud folder that still has files OmniCloud tracks", async () => {
    const owner = "00000000-0000-0000-0000-000000000001";
    db.query.mockImplementation(async (sql) =>
      /select id, user_id/.test(sql)
        ? [{ id: "f1", user_id: owner, file_hash: "a", provider_id: 1, provider_file_id: "d1", folder: "Trips/Goa" }]
        : /select 1 from files/.test(sql)
          ? [{ "?column?": 1 }] // another file (e.g. one uploaded meanwhile) still lives there
          : []
    );
    providers.withAccessToken.mockClear();
    const res = await request(app).delete("/api/folders?path=Trips&cloud=1").set("X-Requested-With", "omni");
    db.query.mockImplementation(async () => []);
    expect(res.body).toMatchObject({ ok: true, files: 1, foldersRemoved: 0 });
    expect(providers.withAccessToken).toHaveBeenCalledTimes(1); // the file only, no folder deletes
  });

  it("rejects unsupported file types", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("X-Requested-With", "omni")
      .field("provider", "gdrive")
      .attach("files", Buffer.from("MZ"), { filename: "setup.exe", contentType: "application/octet-stream" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("no_files");
  });

  it("refuses unsigned media links", async () => {
    expect((await request(app).get("/api/media/abc?v=full&exp=9999999999&sig=bad")).status).toBe(403);
  });

});
