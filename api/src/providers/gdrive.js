import { config } from "../config.js";
import { redis, withLock } from "../lib/redis.js";
import { form, request, requestJson, UpstreamError } from "./http.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_NAME = "OmniCloud";
const FOLDER_MIME = "application/vnd.google-apps.folder";
// drive.file only grants access to files this app created — the least privilege we need.
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

const redirectUri = () => `${config.PUBLIC_URL}/api/oauth/gdrive/callback`;
const auth = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });
// Drive query strings are single-quoted; escape backslashes and quotes.
const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// Parallel uploads into a new folder must not each create their own copy of it: Drive allows
// duplicate names, so find-or-create runs under a lock shared by all worker replicas (and is
// deduplicated in-process first, to spare Redis).
const pendingFolders = new Map();

function childFolder(at, cacheKey, name, parent) {
  if (pendingFolders.has(cacheKey)) return pendingFolders.get(cacheKey);
  const work = (async () => {
    const cached = await redis.get(cacheKey);
    if (cached) return cached;
    return withLock(`omni:lock:${cacheKey}`, () => findOrCreateFolder(at, cacheKey, name, parent), { ttlMs: 30_000 });
  })().finally(() => pendingFolders.delete(cacheKey));
  pendingFolders.set(cacheKey, work);
  return work;
}

async function findOrCreateFolder(at, cacheKey, name, parent) {
  const cached = await redis.get(cacheKey); // another replica may have created it while we waited
  if (cached) return cached;
  const query = `name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and '${q(parent)}' in parents and trashed = false`;
  const list = await requestJson(`${API}/files?${new URLSearchParams({ q: query, fields: "files(id)", pageSize: "1" })}`, {
    headers: auth(at),
  });
  let id = list.files?.[0]?.id;
  if (!id) {
    const created = await requestJson(`${API}/files?fields=id`, {
      method: "POST",
      headers: { ...auth(at), "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    });
    id = created.id;
  }
  await redis.set(cacheKey, id, "EX", 86_400);
  return id;
}

export const gdrive = {
  key: "gdrive",
  label: "Google Drive",

  authorizeUrl(state) {
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },

  async exchangeCode(code) {
    const data = await requestJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: form({
        code,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });
    return { refreshToken: data.refresh_token, accessToken: data.access_token, expiresIn: data.expires_in };
  },

  async refresh(refreshToken) {
    const data = await requestJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: form({
        refresh_token: refreshToken,
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token",
      }),
    });
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  },

  async revoke(refreshToken) {
    await request("https://oauth2.googleapis.com/revoke", { method: "POST", body: form({ token: refreshToken }) });
  },

  async quota(at) {
    const { storageQuota: s } = await requestJson(`${API}/about?fields=storageQuota`, { headers: auth(at) });
    const total = Number(s.limit) || 0;
    const used = Number(s.usage) || 0;
    return { total, used, free: Math.max(0, total - used) };
  },

  // OmniCloud/<folder…> in the user's Drive. Each level is looked up (or created) once and cached.
  async ensureFolder(at, userId, folder = []) {
    let parent = "root";
    let path = "";
    for (const name of [FOLDER_NAME, ...folder]) {
      path += `/${name}`;
      parent = await childFolder(at, `omni:gdrive:folder:${userId}${path === `/${FOLDER_NAME}` ? "" : `:${path}`}`, name, parent);
    }
    return parent;
  },

  async upload(at, { name, folder = [], mime, buffer, userId }) {
    try {
      return await this.uploadInto(at, await this.ensureFolder(at, userId, folder), { name, mime, buffer });
    } catch (err) {
      // A cached folder that was deleted/trashed in Drive: forget the path's ids and retry once.
      if (!(err instanceof UpstreamError && err.status === 404)) throw err;
      const levels = [FOLDER_NAME, ...folder].map((_, i, all) => `/${all.slice(0, i + 1).join("/")}`);
      await redis.del(...levels.map((p) => `omni:gdrive:folder:${userId}${p === `/${FOLDER_NAME}` ? "" : `:${p}`}`));
      return this.uploadInto(at, await this.ensureFolder(at, userId, folder), { name, mime, buffer });
    }
  },

  async uploadInto(at, parent, { name, mime, buffer }) {
    const boundary = `omni${Date.now().toString(36)}`;
    const meta = JSON.stringify({ name, parents: [parent] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const file = await requestJson(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name`, {
      method: "POST",
      headers: { ...auth(at), "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    return { id: file.id, name: file.name };
  },

  media(at, fileId) {
    return request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { headers: auth(at) });
  },

  async thumbnail(at, fileId) {
    const meta = await requestJson(`${API}/files/${encodeURIComponent(fileId)}?fields=thumbnailLink`, {
      headers: auth(at),
    });
    if (!meta.thumbnailLink) return this.media(at, fileId);
    // thumbnailLink ends in =s220; ask for something crisp on retina grids.
    return request(meta.thumbnailLink.replace(/=s\d+$/, "=s640"), { headers: auth(at) });
  },

  async remove(at, fileId) {
    try {
      await request(`${API}/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: auth(at) });
    } catch (err) {
      if (!(err instanceof UpstreamError && err.status === 404)) throw err;
    }
  },

  // Deletes OmniCloud/<folder…> only if nothing is left in it (never anything OmniCloud didn't put there).
  async removeEmptyFolder(at, userId, folder) {
    let id = "root";
    for (const name of [FOLDER_NAME, ...folder]) {
      const query = `name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and '${q(id)}' in parents and trashed = false`;
      const list = await requestJson(`${API}/files?${new URLSearchParams({ q: query, fields: "files(id)", pageSize: "1" })}`, { headers: auth(at) });
      id = list.files?.[0]?.id;
      if (!id) return false;
    }
    const children = await requestJson(
      `${API}/files?${new URLSearchParams({ q: `'${q(id)}' in parents and trashed = false`, fields: "files(id)", pageSize: "1" })}`,
      { headers: auth(at) }
    );
    if (children.files?.length) return false;
    // Trash, not delete: this app only sees files it created, so a folder that looks empty may
    // still hold files you added yourself, and deleting a Drive folder deletes its contents.
    await request(`${API}/files/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...auth(at), "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    await redis.del(`omni:gdrive:folder:${userId}:/${[FOLDER_NAME, ...folder].join("/")}`);
    return true;
  },
};
