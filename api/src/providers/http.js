export class UpstreamError extends Error {
  constructor(status, body, url) {
    super(`Upstream ${status} from ${new URL(url).host}: ${String(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export async function request(url, init = {}) {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  if (!res.ok) throw new UpstreamError(res.status, await res.text().catch(() => ""), url);
  return res;
}

export async function requestJson(url, init) {
  const res = await request(url, init);
  return res.status === 204 ? null : res.json();
}

export const form = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v != null));
