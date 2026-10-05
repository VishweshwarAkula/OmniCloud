import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncRoute, HttpError } from "../lib/errors.js";
import { PROVIDER_KEYS } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { withAccessToken } from "../providers/index.js";
import { filesByHashes, filterHashes, getFile, knownPlaces, listFiles, serializeFile, topFolders, topTags } from "../services/files.js";
import { removeFile, removeFolder } from "../services/removal.js";
import { capabilities, rerankResults, searchImages, understandQuery } from "../services/ml.js";
import { namedPeople } from "../services/people.js";
import { config } from "../config.js";
import { redis } from "../lib/redis.js";

const router = Router();

router.get(
  "/files",
  requireAuth,
  asyncRoute(async (req, res) => {
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 30));
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const tag = typeof req.query.tag === "string" && req.query.tag.length <= 40 ? req.query.tag : undefined;
    const person = typeof req.query.person === "string" && /^[0-9a-f-]{36}$/i.test(req.query.person) ? req.query.person : undefined;
    const folder = typeof req.query.folder === "string" && req.query.folder.length <= 1300 ? req.query.folder : undefined;
    res.json(await listFiles(req.user.id, { limit, cursor, tag, person, folder }));
  })
);

router.get(
  "/files/tags",
  requireAuth,
  asyncRoute(async (req, res) => res.json({ tags: await topTags(req.user.id) }))
);

router.get(
  "/files/folders",
  requireAuth,
  asyncRoute(async (req, res) => res.json({ folders: await topFolders(req.user.id) }))
);

router.delete(
  "/files/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const row = await getFile(req.params.id);
    if (!row || row.user_id !== req.user.id) throw new HttpError(404, "File not found.");
    // Default: forget the file in OmniCloud only; the cloud copy stays. ?cloud=1 deletes it there too.
    const fromCloud = req.query.cloud === "1";
    await removeFile(row, { fromCloud });
    res.json({ ok: true, deletedFromCloud: fromCloud });
  })
);

// Everything under a folder (subfolders included). Same choice as for one file.
router.delete(
  "/folders",
  requireAuth,
  asyncRoute(async (req, res) => {
    const folder = typeof req.query.path === "string" ? req.query.path.replace(/^\/+|\/+$/g, "") : "";
    if (!folder || folder.length > 1300) throw new HttpError(400, "Folder path is required.");
    const fromCloud = req.query.cloud === "1";
    const result = await removeFolder(req.user.id, folder, { fromCloud });
    if (!result.files && !result.failed) throw new HttpError(404, "No files in that folder.");
    res.json({ ok: !result.failed, deletedFromCloud: fromCloud, ...result });
  })
);

const searchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req) => req.user.id,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

// Grounding for query understanding: the user's named people and known places (cached briefly).
async function searchContext(userId) {
  const key = `omni:searchctx:${userId}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  const [people, places] = await Promise.all([namedPeople(userId), knownPlaces(userId)]);
  const ctx = { people, places };
  await redis.set(key, JSON.stringify(ctx), "EX", 60);
  return ctx;
}

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

// Thumbnails for API re-ranking (Gemini looks at them). Oversized originals are skipped.
async function thumbnailsB64(userId, rows) {
  const out = {};
  await Promise.allSettled(
    rows.map(async (row) => {
      const res = await withAccessToken(userId, PROVIDER_KEYS[row.provider_id], (at, p) => p.thumbnail(at, row.provider_file_id));
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length <= 4 * 1024 * 1024) out[row.file_hash] = buf.toString("base64");
    })
  );
  return out;
}

/*
  Search pipeline
    1. understand  free text → {visual query, dates, places, people, kinds}   (rules + local LLM)
    2. filter      structured parts → allow-list of file hashes in Postgres
    3. retrieve    hybrid vector + BM25 inside the allow-list                   (ML service)
    4. re-rank     top-N second pass                                          (Gemini vision → local SigLIP/MMR)
  Every stage degrades gracefully: if one fails, the previous stage's answer stands.
*/
router.post(
  "/search",
  requireAuth,
  searchLimiter,
  asyncRoute(async (req, res) => {
    const userId = req.user.id;
    const q = String(req.body?.query ?? "").trim().slice(0, 300);
    if (!q) throw new HttpError(400, "Search query is required.");
    const k = Math.min(60, Math.max(1, Number(req.body?.k) || 30));

    const ctx = await searchContext(userId);
    let u;
    try {
      // Same query, same day, same known people/places → same interpretation: don't spend API quota twice.
      const today = new Date().toISOString().slice(0, 10);
      const ctxHash = crypto.createHash("sha1").update(JSON.stringify([q.toLowerCase(), today, ctx])).digest("hex");
      const cacheKey = `omni:uq:${userId}:${ctxHash}`;
      const cached = await redis.get(cacheKey);
      u = cached ? JSON.parse(cached) : await understandQuery({ query: q, today, people: ctx.people.map((p) => p.name), places: ctx.places });
      // Model answers are cached (the fast first phase and the re-ranked second phase share one call).
      if (!cached && (u.source === "gemini" || u.source === "llm")) await redis.set(cacheKey, JSON.stringify(u), "EX", 86_400);
    } catch (err) {
      req.log.warn({ err: err.message }, "query understanding unavailable");
      u = { visual_query: q, people: [], places: [], kinds: [], source: "none" };
    }
    const byName = new Map(ctx.people.map((p) => [p.name.toLowerCase(), p.id]));
    const personIds = u.people.map((n) => byName.get(n.toLowerCase())).filter(Boolean);
    const understood = {
      visual: u.visual_query ?? null,
      dateFrom: u.date_from ?? null,
      dateTo: u.date_to ?? null,
      places: u.places,
      people: u.people,
      kinds: u.kinds,
      months: u.months ?? [],
      source: u.source,
    };

    const allow = await filterHashes(userId, { dateFrom: u.date_from, dateTo: u.date_to, months: u.months, kinds: u.kinds, places: u.places, personIds });
    if (allow && !allow.length) return res.json({ query: q, understood, reranked: null, items: [], documents: [] });

    let visual = u.visual_query;
    if (!visual && !allow) visual = q; // nothing structured recognised: plain semantic search
    let ranked;
    let docHits = [];
    if (visual) {
      // Once understood, dates/places/people are already filters: keywords only see the visual part,
      // otherwise "goa" in "beach in goa" would keyword-match every Goa photo, beach or not.
      const keywordQuery = u.source === "none" ? q : visual;
      const { results, doc_results: docResults = [] } = await searchImages({ userId, query: visual, keywordQuery, k: Math.max(k, config.RERANK_TOP_N), allow: allow ?? undefined });
      ranked = results;
      docHits = docResults;
    } else {
      // Pure filter query ("photos of Rahul in Goa"): newest matches first.
      ranked = allow.slice(0, k).map((file_hash) => ({ file_hash, score: 1, prob: null, match: null }));
    }

    let reranked = null;
    // `rerank: false` = fast first phase; the client asks again with rerank on and swaps the order in.
    const wantRerank = req.body?.rerank !== false;
    if (wantRerank && visual && config.RERANK_MODE !== "off" && ranked.length > 2) {
      try {
        const top = ranked.slice(0, config.RERANK_TOP_N);
        const caps = await capabilities().catch(() => ({}));
        let images;
        if (caps.rerank === "api" && config.RERANK_MODE !== "local") {
          images = await withTimeout(thumbnailsB64(userId, await filesByHashes(userId, top.map((r) => r.file_hash))), 6_000);
        }
        const rr = await withTimeout(
          rerankResults({ user_id: userId, query: visual, candidates: top.map((r) => ({ file_hash: r.file_hash, score: r.score })), images }),
          15_000
        );
        const first = new Map(ranked.map((r) => [r.file_hash, r]));
        // An API re-ranker judges relevance itself (its own label); a local one only reorders.
        ranked = [
          ...rr.results.map((r) => ({ ...first.get(r.file_hash), score: r.score, match: r.match ?? first.get(r.file_hash)?.match ?? null })),
          ...ranked.slice(config.RERANK_TOP_N),
        ];
        reranked = rr.source;
      } catch (err) {
        req.log.warn({ err: err.message }, "re-ranking skipped");
      }
    }

    ranked = ranked.slice(0, k);
    const rows = await filesByHashes(userId, [...ranked.map((r) => r.file_hash), ...docHits.map((h) => h.file_hash)]);
    const byHash = new Map(rows.map((r) => [r.file_hash, r]));
    const isDoc = (h) => byHash.get(h)?.media_type === "document";
    const items = ranked
      .filter((r) => byHash.has(r.file_hash) && !isDoc(r.file_hash))
      .map((r) => serializeFile(byHash.get(r.file_hash), { match: r.match ?? null }));
    // Documents: the best-matching passage of each (from the ML service), or — for a pure filter
    // query like "documents from last week" — the matching files themselves.
    const documents = docHits.length
      ? docHits
          .filter((h) => byHash.has(h.file_hash))
          .map((h) => serializeFile(byHash.get(h.file_hash), { match: h.match, page: h.page, snippet: h.snippet }))
      : ranked.filter((r) => isDoc(r.file_hash)).map((r) => serializeFile(byHash.get(r.file_hash), { match: null }));
    res.json({ query: q, understood, reranked, items, documents });
  })
);

export default router;
