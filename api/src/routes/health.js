import { Router } from "express";
import { pool } from "../db/index.js";
import { asyncRoute } from "../lib/errors.js";
import { redis } from "../lib/redis.js";
import { requireAuth } from "../middleware/auth.js";
import { queueBacklog } from "../queues/index.js";
import { capabilities } from "../services/ml.js";

const router = Router();

router.get("/health", async (_req, res) => {
  const [redisOk, dbOk] = await Promise.all([
    redis.ping().then(() => true, () => false),
    pool.query("select 1").then(() => true, () => false),
  ]);
  const ok = redisOk && dbOk;
  res.status(ok ? 200 : 503).json({ ok, service: "omnicloud-api", redis: redisOk, postgres: dbOk });
});

// Live pipeline view: queue depth per stage and what the autoscaler is doing.
router.get(
  "/system/pipeline",
  requireAuth,
  asyncRoute(async (_req, res) => {
    const [backlog, scale] = await Promise.all([queueBacklog(), redis.hgetall("omni:scale")]);
    res.json({
      backlog,
      scaling: Object.fromEntries(Object.entries(scale).map(([svc, v]) => [svc, JSON.parse(v)])),
    });
  })
);

// Which AI features run via an API and which locally (shown in Settings).
router.get(
  "/system/capabilities",
  requireAuth,
  asyncRoute(async (_req, res) => res.json(await capabilities().catch(() => ({ unavailable: true }))))
);

export default router;
