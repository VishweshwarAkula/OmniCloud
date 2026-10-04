import crypto from "node:crypto";
import { Router } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import rateLimit from "express-rate-limit";
import { config, googleLoginConfigured } from "../config.js";
import { one } from "../db/index.js";
import { asyncRoute, HttpError } from "../lib/errors.js";
import { redis } from "../lib/redis.js";
import { clearSessionCookie, COOKIE, createSession, destroySession, parseCookies, setSessionCookie } from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";
import { form, requestJson } from "../providers/http.js";

const router = Router();
const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const redirectUri = () => `${config.PUBLIC_URL}/api/auth/google/callback`;
const safeNext = (n) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") ? n : "/app");
const b64url = (buf) => buf.toString("base64url");

const toPublicUser = (u) => ({ id: u.id, email: u.email, name: u.name, avatar: u.avatar_url, createdAt: u.created_at });

async function signInUser(res, row) {
  const user = toPublicUser(row);
  setSessionCookie(res, await createSession(user));
  return user;
}

router.get("/auth/config", (_req, res) => res.json({ google: googleLoginConfigured, devLogin: config.DEV_LOGIN }));

const loginLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

// Google OIDC sign-in with PKCE; state + verifier live in Redis for 10 minutes and are single-use.
router.get(
  "/auth/google/start",
  loginLimiter,
  asyncRoute(async (req, res) => {
    if (!googleLoginConfigured) throw new HttpError(503, "Google sign-in is not configured.");
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    await redis.set(`omni:login:${state}`, JSON.stringify({ verifier, next: safeNext(req.query.next) }), "EX", 600);
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: "openid email profile",
      prompt: "select_account",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  })
);

router.get(
  "/auth/google/callback",
  asyncRoute(async (req, res) => {
    const fail = (reason) => res.redirect(`${config.PUBLIC_URL}/?auth_error=${encodeURIComponent(reason)}`);
    const { code, state, error } = req.query;
    if (error) return fail("cancelled");
    if (typeof state !== "string" || typeof code !== "string") return fail("invalid");
    const raw = await redis.getdel(`omni:login:${state}`);
    if (!raw) return fail("expired");
    const { verifier, next } = JSON.parse(raw);

    try {
      const tokens = await requestJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: form({
          code,
          code_verifier: verifier,
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri(),
          grant_type: "authorization_code",
        }),
      });
      const { payload } = await jwtVerify(tokens.id_token, googleJwks, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: config.GOOGLE_CLIENT_ID,
      });
      if (!payload.email || payload.email_verified !== true) return fail("unverified");

      const row = await one(
        `insert into users (google_sub, email, name, avatar_url, last_login_at)
         values ($1, lower($2), $3, $4, now())
         on conflict (email) do update
           set google_sub = excluded.google_sub, name = excluded.name,
               avatar_url = excluded.avatar_url, last_login_at = now()
         returning *`,
        [payload.sub, payload.email, payload.name ?? null, payload.picture ?? null]
      );
      await signInUser(res, row);
      res.redirect(`${config.PUBLIC_URL}${next}`);
    } catch (err) {
      req.log.error({ err: err.message }, "google sign-in failed");
      fail("failed");
    }
  })
);

router.post(
  "/auth/dev",
  loginLimiter,
  asyncRoute(async (req, res) => {
    if (!config.DEV_LOGIN) throw new HttpError(404, "Not found.");
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email.");
    const row = await one(
      `insert into users (email, name, last_login_at) values ($1, $2, now())
       on conflict (email) do update set last_login_at = now()
       returning *`,
      [email, email.split("@")[0]]
    );
    res.json({ user: await signInUser(res, row) });
  })
);

router.get("/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));

router.post(
  "/auth/logout",
  asyncRoute(async (req, res) => {
    await destroySession(parseCookies(req.get("cookie"))[COOKIE]);
    clearSessionCookie(res);
    res.json({ ok: true });
  })
);

export default router;
