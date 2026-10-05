import { HttpError } from "../lib/errors.js";
import { request, UpstreamError } from "./http.js";

// Koofr: 10 GB free, no developer app needed. The user creates an *app password* in Koofr's settings;
// we store {email, password} (encrypted) and use HTTP Basic auth. Files go over WebDAV on the
// primary "Koofr" mount; quota comes from the REST API.
const BASE = "https://app.koofr.net";
const DAV = `${BASE}/dav/Koofr`;
const FOLDER = "OmniCloud";
const parse = (cred) => (typeof cred === "string" ? JSON.parse(cred) : cred);
const auth = (cred) => {
  const { email, password } = parse(cred);
  return { Authorization: `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}` };
};
const davPath = (id) => `${DAV}/${id.split("/").map(encodeURIComponent).join("/")}`;
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic", ".pdf": "application/pdf" };

async function exists(cred, id) {
  try {
    await request(davPath(id), { method: "PROPFIND", headers: { ...auth(cred), Depth: "0" } });
    return true;
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return false;
    throw err;
  }
}

export const koofr = {
  key: "koofr",
  label: "Koofr",
  static: true,
  credentials: true, // connected with email + app password instead of OAuth

  // Checks the credentials before storing them.
  async verify({ email, password }) {
    if (!/^\S+@\S+\.\S+$/.test(email || "") || !password) throw new HttpError(400, "Enter your Koofr email and an app password.");
    try {
      await request(`${DAV}/`, { method: "PROPFIND", headers: { ...auth({ email, password }), Depth: "0" } });
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        throw new HttpError(400, "Koofr rejected these credentials. Use an app password, not your login password.", "bad_credentials");
      }
      throw err;
    }
    return JSON.stringify({ email, password });
  },

  async revoke() {
    // App passwords are revoked in Koofr's settings; we just forget it.
  },

  async quota(cred) {
    const res = await request(`${BASE}/api/v2/mounts`, { headers: { ...auth(cred), Accept: "application/json" } });
    const { mounts = [] } = await res.json();
    const m = mounts.find((x) => x.isPrimary) ?? mounts[0];
    if (!m) return { total: 0, used: 0, free: 0 };
    // Koofr reports mount space in MB.
    const total = (m.spaceTotal ?? 0) * 1024 * 1024;
    const used = (m.spaceUsed ?? 0) * 1024 * 1024;
    return { total, used, free: Math.max(0, total - used) };
  },

  async upload(cred, { name, folder = [], mime, buffer, hash }) {
    // Create OmniCloud/<folder…> level by level. MKCOL is idempotent enough: 405 means it exists.
    let dir = FOLDER;
    for (const level of [null, ...folder]) {
      if (level) dir += `/${level}`;
      await request(davPath(dir), { method: "MKCOL", headers: auth(cred) }).catch((err) => {
        if (!(err instanceof UpstreamError && err.status === 405)) throw err;
      });
    }
    // WebDAV PUT overwrites. "If-None-Match: *" makes it create-only (412 if the name is taken),
    // so two different files with the same name can't overwrite each other even when uploaded at
    // the same moment; the second one gets its content hash appended. The exists() pre-check
    // covers servers that ignore the header.
    const dot = name.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    const candidates = [name, `${base} (${String(hash).slice(0, 8)})${ext}`];
    for (const [i, candidate] of candidates.entries()) {
      const id = `${dir}/${candidate}`;
      const last = i === candidates.length - 1;
      // The hash-named copy is this exact content, so overwriting it on a retry is harmless.
      if (!last && (await exists(cred, id))) continue;
      try {
        await request(davPath(id), {
          method: "PUT",
          headers: { ...auth(cred), "Content-Type": mime || "application/octet-stream", ...(!last && { "If-None-Match": "*" }) },
          body: buffer,
          signal: AbortSignal.timeout(120_000),
        });
        return { id, name: candidate };
      } catch (err) {
        if (!(err instanceof UpstreamError && err.status === 412) || last) throw err;
      }
    }
  },

  async media(cred, id) {
    const res = await request(davPath(id), { headers: auth(cred) });
    const ext = id.slice(id.lastIndexOf(".")).toLowerCase();
    // WebDAV may answer application/octet-stream; give the browser a usable type.
    if (!res.headers.get("content-type")?.startsWith("image/") && MIME[ext]) {
      return new Response(res.body, { headers: { "content-type": MIME[ext], "content-length": res.headers.get("content-length") ?? "" } });
    }
    return res;
  },

  thumbnail(cred, id) {
    return this.media(cred, id);
  },

  async remove(cred, id) {
    await request(davPath(id), { method: "DELETE", headers: auth(cred) }).catch((err) => {
      if (!(err instanceof UpstreamError && err.status === 404)) throw err;
    });
  },

  async removeEmptyFolder(cred, _userId, folder) {
    const dir = [FOLDER, ...folder].join("/");
    let body;
    try {
      body = await (await request(davPath(dir), { method: "PROPFIND", headers: { ...auth(cred), Depth: "1" } })).text();
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) return false;
      throw err;
    }
    // One <response> is the folder itself; any more are its contents.
    if ((body.match(/<(?:\w+:)?response[\s>]/gi) || []).length > 1) return false;
    await this.remove(cred, dir);
    return true;
  },
};
