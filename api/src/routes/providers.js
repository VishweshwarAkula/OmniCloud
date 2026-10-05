import crypto from "node:crypto";
import { Router } from "express";
import { config, providerConfigured } from "../config.js";
import { asyncRoute, HttpError } from "../lib/errors.js";
import { genKey, redis } from "../lib/redis.js";
import { requireAuth } from "../middleware/auth.js";
import {
  connectedProviders,
  deleteRefreshToken,
  getProvider,
  getRefreshToken,
  providers,
  saveRefreshToken,
  withAccessToken,
} from "../providers/index.js";

const router = Router();
const STATE_TTL = 600;

router.get(
  "/providers",
  requireAuth,
  asyncRoute(async (req, res) => {
    const connected = new Set(await connectedProviders(req.user.id));
    res.json({
      providers: Object.values(providers).map((p) => ({
        key: p.key,
        label: p.label,
        available: providerConfigured[p.key],
        method: p.credentials ? "credentials" : "oauth",
        connected: connected.has(p.key),
      })),
    });
  })
);

// Quotas change slowly; cache the combined answer briefly and query providers in parallel.
router.get(
  "/providers/storage",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.user.id;
    const cacheKey = await genKey(`omni:quota:${userId}`); // see genKey: uploads/deletes invalidate it
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const keys = await connectedProviders(userId);
    const settled = await Promise.allSettled(keys.map((k) => withAccessToken(userId, k, (at, p) => p.quota(at))));

    const overall = { total: 0, used: 0, free: 0 };
    const perProvider = {};
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        perProvider[keys[i]] = r.value;
        overall.total += r.value.total;
        overall.used += r.value.used;
        overall.free += r.value.free;
      } else {
        perProvider[keys[i]] = { error: r.reason?.code === "provider_reauth" ? "reauth" : "unavailable" };
      }
    });

    const payload = { overall, providers: perProvider };
    if (settled.every((r) => r.status === "fulfilled")) await redis.set(cacheKey, JSON.stringify(payload), "EX", 300);
    res.json(payload);
  })
);

// Returns the provider authorize URL. The state is random, single-use, and bound
// to the authenticated user server-side, which closes the old CSRF/account-mixup hole.
router.post(
  "/oauth/:provider/start",
  requireAuth,
  asyncRoute(async (req, res) => {
    const provider = getProvider(req.params.provider);
    if (provider.credentials) throw new HttpError(400, `${provider.label} connects with an app password, not OAuth.`);
    const state = crypto.randomBytes(24).toString("base64url");
    await redis.set(`omni:oauth:${state}`, JSON.stringify({ userId: req.user.id, provider: provider.key }), "EX", STATE_TTL);
    res.json({ url: provider.authorizeUrl(state) });
  })
);

router.get(
  "/oauth/:provider/callback",
  asyncRoute(async (req, res) => {
    const back = (status, extra = "") =>
      res.redirect(`${config.PUBLIC_URL}/app/settings?connected=${encodeURIComponent(req.params.provider)}&status=${status}${extra}`);

    const { code, state, error } = req.query;
    if (error) return back("denied");
    if (typeof state !== "string" || typeof code !== "string") return back("error");

    const raw = await redis.getdel(`omni:oauth:${state}`);
    const pending = raw && JSON.parse(raw);
    if (!pending || pending.provider !== req.params.provider) return back("expired");

    try {
      const provider = getProvider(pending.provider);
      const { refreshToken } = await provider.exchangeCode(code, req.query); // pCloud adds its data-centre hostname
      if (!refreshToken) return back("error", "&reason=no_refresh_token");
      await saveRefreshToken(pending.userId, provider.key, refreshToken);
      back("success");
    } catch (err) {
      req.log.error({ err, provider: pending.provider }, "oauth callback failed");
      back("error");
    }
  })
);

// Providers connected with credentials instead of OAuth (Koofr: email + app password).
router.post(
  "/providers/:provider/credentials",
  requireAuth,
  asyncRoute(async (req, res) => {
    const provider = getProvider(req.params.provider);
    if (!provider.credentials) throw new HttpError(400, `${provider.label} connects through its own sign-in page.`);
    const credential = await provider.verify({ email: String(req.body?.email ?? "").trim(), password: String(req.body?.password ?? "") });
    await saveRefreshToken(req.user.id, provider.key, credential);
    res.json({ ok: true });
  })
);

router.post(
  "/providers/:provider/disconnect",
  requireAuth,
  asyncRoute(async (req, res) => {
    const provider = getProvider(req.params.provider);
    const refreshToken = await getRefreshToken(req.user.id, provider.key);
    if (!refreshToken) throw new HttpError(404, `${provider.label} is not connected.`);
    // Revocation is best effort; we always forget the token locally.
    await provider.revoke(refreshToken).catch((err) => req.log.warn({ err: err.message }, "remote revoke failed"));
    await deleteRefreshToken(req.user.id, provider.key);
    res.json({ ok: true });
  })
);

export default router;
