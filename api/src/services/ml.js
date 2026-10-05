import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { Agent } from "undici";

const headers = () => (config.ML_SERVICE_TOKEN ? { "X-Service-Token": config.ML_SERVICE_TOKEN } : {});

/*
  Client-side load balancing across ML replicas. Docker's DNS returns one A record per
  replica of the `ml` service; keep-alive connections would otherwise pin every request
  to a single replica. Addresses are re-resolved every few seconds so autoscaled replicas
  join (and leave) the rotation quickly.
*/
const mlUrl = new URL(config.ML_URL);
let dnsCache = { at: 0, addrs: [] };

async function mlAddresses() {
  if (net.isIP(mlUrl.hostname) || mlUrl.hostname === "localhost") return [mlUrl.hostname];
  if (Date.now() - dnsCache.at > 5_000) {
    const addrs = await dns.lookup(mlUrl.hostname, { all: true, family: 4 }).then(
      (r) => r.map((a) => a.address),
      () => []
    );
    dnsCache = { at: Date.now(), addrs };
  }
  return dnsCache.addrs.length ? dnsCache.addrs : [mlUrl.hostname];
}

// fetch gives up after 5 minutes without response headers (undici's headersTimeout), whatever the
// AbortSignal says. Long calls (indexing a 900-page book) get a dispatcher that waits as long as they may.
const longCalls = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

async function call(path, init, timeout = 60_000) {
  const addrs = [...(await mlAddresses())].sort(() => Math.random() - 0.5);
  let lastErr;
  // A replica that is still loading its model refuses connections; try the next one.
  for (const host of addrs.slice(0, 3)) {
    const base = `${mlUrl.protocol}//${host}:${mlUrl.port || (mlUrl.protocol === "https:" ? 443 : 80)}`;
    try {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...headers(), ...init.headers },
        signal: AbortSignal.timeout(timeout),
        ...(timeout > 240_000 && { dispatcher: longCalls }),
      });
      if (res.status === 503) {
        lastErr = new HttpError(503, "ML replica not ready", "ml_unavailable");
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new HttpError(res.status === 422 ? 422 : 502, `ML service ${res.status}: ${text.slice(0, 200)}`, "ml_error");
      }
      return res.json();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("ML service unreachable");
}

function imageForm({ userId, fileHash, buffer, mime, name, filename }) {
  const body = new FormData();
  body.set("image", new Blob([buffer], { type: mime }), name);
  if (userId) body.set("user_id", userId);
  if (fileHash) body.set("file_hash", fileHash);
  // The original filename carries useful words and dates ("IMG_20240316_goa-trip.jpg").
  if (filename) body.set("filename", filename.slice(0, 512));
  return body;
}

export const embedImage = (args) => call("/embed", { method: "POST", body: imageForm(args) }, 120_000);
export const detectFaces = (args) => call("/faces", { method: "POST", body: imageForm(args) }, 120_000);

export function indexDocument({ userId, fileHash, buffer, mime, filename }) {
  const body = new FormData();
  body.set("file", new Blob([buffer], { type: mime }), filename);
  body.set("user_id", userId);
  body.set("file_hash", fileHash);
  body.set("filename", filename.slice(0, 512));
  return call("/documents/index", { method: "POST", body }, 30 * 60_000); // ~1,600 chunks (900 pages) take minutes on CPU
}

const json = (path, body, timeout) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);

export const mergeFaces = ({ userId, sources, target }) => json("/faces/merge", { user_id: userId, sources, target }, 60_000);
export const understandQuery = (body) => json("/understand", body, 12_000);
export const rerankResults = (body) => json("/rerank", body, 20_000);

let capsCache = { at: 0, value: null };
// What the ML service can do right now (API vs local for each feature); cached for a minute.
export async function capabilities() {
  if (capsCache.value && Date.now() - capsCache.at < 60_000) return capsCache.value;
  const info = await call("/healthz", { method: "GET" }, 5_000);
  capsCache = { at: Date.now(), value: { model: info.model, ...info.capabilities } };
  return capsCache.value;
}

export const modelInfo = () => call("/healthz", { method: "GET" }, 10_000);

export const searchImages = ({ userId, query, keywordQuery, k, allow }) =>
  json("/search", { user_id: userId, query: query ?? "", keyword_query: keywordQuery ?? null, k, allow: allow ?? null }, 20_000);

export const deleteFromIndex = ({ userId, fileHash }) =>
  call(`/index/${encodeURIComponent(userId)}/${encodeURIComponent(fileHash)}`, { method: "DELETE" }, 20_000);
