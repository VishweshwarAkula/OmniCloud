import { providerConfigured } from "../config.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { HttpError, ProviderAuthError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { bumpGen, genKey, redis } from "../lib/redis.js";
import { PROVIDER_IDS, one, query } from "../db/index.js";
import { dropbox } from "./dropbox.js";
import { gdrive } from "./gdrive.js";
import { koofr } from "./koofr.js";
import { pcloud } from "./pcloud.js";
import { UpstreamError } from "./http.js";

export const providers = { gdrive, dropbox, koofr, pcloud };

export function getProvider(key) {
  const provider = providers[key];
  if (!provider) throw new HttpError(400, `Unknown provider '${key}'.`);
  if (!providerConfigured[key]) throw new HttpError(503, `${provider.label} is not configured on this server.`);
  return provider;
}

/* ----------------------------- refresh tokens ----------------------------- */

export async function saveRefreshToken(userId, key, refreshToken) {
  await query(
    `insert into refresh_tokens (user_id, provider_id, refresh_token) values ($1, $2, $3)
     on conflict (user_id, provider_id) do update set refresh_token = excluded.refresh_token, created_at = now()`,
    [userId, PROVIDER_IDS[key], encrypt(refreshToken)]
  );
  await invalidateUserCaches(userId, key);
}

export async function getRefreshToken(userId, key) {
  const row = await one("select refresh_token from refresh_tokens where user_id = $1 and provider_id = $2", [
    userId,
    PROVIDER_IDS[key],
  ]);
  return row ? decrypt(row.refresh_token) : null;
}

export async function deleteRefreshToken(userId, key) {
  await query("delete from refresh_tokens where user_id = $1 and provider_id = $2", [userId, PROVIDER_IDS[key]]);
  await invalidateUserCaches(userId, key);
}

export async function connectedProviders(userId) {
  const rows = await query("select provider_id from refresh_tokens where user_id = $1", [userId]);
  const ids = new Set(rows.map((r) => r.provider_id));
  return Object.keys(PROVIDER_IDS).filter((k) => ids.has(PROVIDER_IDS[k]));
}

export async function invalidateUserCaches(userId, key) {
  await bumpGen(`omni:at:${key}:${userId}`, `omni:quota:${userId}`);
}

/* ------------------------------ access tokens ----------------------------- */

const inflight = new Map();

// Access tokens are cached in Redis until shortly before expiry, and concurrent
// refreshes for the same user/provider share one upstream call.
export async function getAccessToken(userId, key) {
  // Providers with non-expiring credentials (pCloud token, Koofr app password): use them as stored.
  if (providers[key]?.static) {
    const stored = await getRefreshToken(userId, key);
    if (!stored) throw new HttpError(409, `Connect ${providers[key].label} first.`, "provider_not_connected");
    return stored;
  }
  // Generation-tagged: a refresh that started before a reconnect can't cache the old account's token.
  const cacheKey = await genKey(`omni:at:${key}:${userId}`);
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  const pending = (async () => {
    const refreshToken = await getRefreshToken(userId, key);
    if (!refreshToken) throw new HttpError(409, `Connect ${providers[key].label} first.`, "provider_not_connected");
    try {
      const { accessToken, expiresIn } = await getProvider(key).refresh(refreshToken);
      const ttl = Math.max(60, (expiresIn || 3600) - 120);
      await redis.set(cacheKey, accessToken, "EX", ttl);
      return accessToken;
    } catch (err) {
      if (err instanceof UpstreamError && err.status >= 400 && err.status < 500) {
        logger.warn({ userId, provider: key, status: err.status }, "refresh token rejected");
        throw new ProviderAuthError(providers[key].label);
      }
      throw err;
    }
  })().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, pending);
  return pending;
}

// Runs fn with a valid access token, retrying once with a fresh token on a 401.
export async function withAccessToken(userId, key, fn) {
  const at = await getAccessToken(userId, key);
  try {
    return await fn(at, getProvider(key));
  } catch (err) {
    if (!(err instanceof UpstreamError && err.status === 401)) throw err;
    // A static credential that gets a 401 was revoked on the provider's side: ask to reconnect.
    if (providers[key]?.static) throw new ProviderAuthError(providers[key].label);
    await bumpGen(`omni:at:${key}:${userId}`);
    return fn(await getAccessToken(userId, key), getProvider(key));
  }
}
