import { Router } from "express";
import rateLimit from "express-rate-limit";
import { asyncRoute, HttpError } from "../lib/errors.js";
import { PROVIDER_KEYS, query } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { withAccessToken } from "../providers/index.js";
import { deleteFileRow, filesByHashes, filterHashes, getFile, knownPlaces, listFiles, serializeFile, topTags } from "../services/files.js";
import { capabilities, deleteFromIndex, rerankResults, searchImages, understandQuery } from "../services/ml.js";
import { namedPeople, refreshPeopleOfFile } from "../services/people.js";
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
    res.json(await listFiles(req.user.id, { limit, cursor, tag, person }));
  })
);

router.get(
  "/files/tags",
  requireAuth,
  asyncRoute(async (req, res) => res.json({ tags: await topTags(req.user.id) }))
);

router.delete(
  "/files/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const row = await getFile(req.params.id);
    if (!row || row.user_id !== req.user.id) throw new HttpError(404, "File not found.");
    const key = PROVIDER_KEYS[row.provider_id];
    if (row.provider_file_id) await withAccessToken(req.user.id, key, (at, p) => p.remove(at, row.provider_file_id));
    await deleteFromIndex({ userId: req.user.id, fileHash: row.file_hash }).catch((err) =>
      req.log.warn({ err: err.message }, "index delete failed")
    );
    const affected = (await query("select distinct person_id from faces where file_id = $1 and person_id is not null", [row.id])).map((r) => r.person_id);
    await deleteFileRow(row.id); // faces cascade
    await refreshPeopleOfFile(affected);
    await redis.del(`omni:searchctx:${req.user.id}`);
    res.json({ ok: true });
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
    1. understand  free text → {visual query, dates, places, people, kinds}   (Gemini → local rules)
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
      u = await understandQuery({ query: q, today: new Date().toISOString().slice(0, 10), people: ctx.people.map((p) => p.name), places: ctx.places });
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
    if (allow && !allow.length) return res.json({ query: q, understood, reranked: null, items: [] });

    let visual = u.visual_query;
    if (!visual && !allow) visual = q; // nothing structured recognised: plain semantic search
    let ranked;
    if (visual) {
      // Once understood, dates/places/people are already filters: keywords only see the visual part,
      // otherwise "goa" in "beach in goa" would keyword-match every Goa photo, beach or not.
      const keywordQuery = u.source === "none" ? q : visual;
      const { results } = await searchImages({ userId, query: visual, keywordQuery, k: Math.max(k, config.RERANK_TOP_N), allow: allow ?? undefined });
      ranked = results;
    } else {
      // Pure filter query ("photos of Rahul in Goa"): newest matches first.
      ranked = allow.slice(0, k).map((file_hash) => ({ file_hash, score: 1, prob: null }));
    }

    let reranked = null;
    if (visual && config.RERANK_MODE !== "off" && ranked.length > 2) {
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
        const prob = new Map(ranked.map((r) => [r.file_hash, r.prob]));
        ranked = [...rr.results.map((r) => ({ ...r, prob: prob.get(r.file_hash) ?? null })), ...ranked.slice(config.RERANK_TOP_N)];
        reranked = rr.source;
      } catch (err) {
        req.log.warn({ err: err.message }, "re-ranking skipped");
      }
    }

    ranked = ranked.slice(0, k);
    const rows = await filesByHashes(userId, ranked.map((r) => r.file_hash));
    const byHash = new Map(rows.map((r) => [r.file_hash, r]));
    const items = ranked
      .filter((r) => byHash.has(r.file_hash))
      .map((r) => serializeFile(byHash.get(r.file_hash), { score: r.score, relevance: r.prob }));
    res.json({ query: q, understood, reranked, items });
  })
);

router.get(
  "/bills/summary",
  requireAuth,
  asyncRoute(async (req, res) => {
    const uid = req.user.id;
    const [byCurrency, byMonth, receipts] = await Promise.all([
      query(
        `select coalesce(currency, '') as currency, sum(total)::float8 as total, count(*)::int as count
         from receipts where user_id = $1 group by 1 order by 2 desc nulls last`,
        [uid]
      ),
      // Monthly chart uses the dominant currency only (mixing currencies in one bar is meaningless).
      query(
        `with main as (select currency from receipts where user_id = $1 group by currency order by sum(total) desc nulls last limit 1)
         select to_char(date_trunc('month', coalesce(receipt_date, created_at::date)), 'YYYY-MM') as month, sum(total)::float8 as total
         from receipts where user_id = $1 and currency is not distinct from (select currency from main)
         group by 1 order by 1 desc limit 12`,
        [uid]
      ),
      query(
        `select id, file_id, total, currency, vendor, receipt_date, confidence, created_at
         from receipts where user_id = $1 order by receipt_date desc nulls last, created_at desc limit 100`,
        [uid]
      ),
    ]);
    const primary = byCurrency[0];
    res.json({
      count: byCurrency.reduce((s, r) => s + r.count, 0),
      total: primary?.total ?? 0,
      currency: primary?.currency || null,
      byCurrency: Object.fromEntries(byCurrency.map((r) => [r.currency || "—", r.total ?? 0])),
      byMonth: byMonth.reverse(),
      receipts,
    });
  })
);

export default router;
