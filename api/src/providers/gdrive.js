import { config } from "../config.js";
import { redis } from "../lib/redis.js";
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

  async ensureFolder(at, userId) {
    const cacheKey = `omni:gdrive:folder:${userId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return cached;

    const query = `name = '${q(FOLDER_NAME)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
    const list = await requestJson(`${API}/files?${new URLSearchParams({ q: query, fields: "files(id)", pageSize: "1" })}`, {
      headers: auth(at),
    });
    let id = list.files?.[0]?.id;
    if (!id) {
      const created = await requestJson(`${API}/files?fields=id`, {
        method: "POST",
        headers: { ...auth(at), "Content-Type": "application/json" },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: ["root"] }),
      });
      id = created.id;
    }
    await redis.set(cacheKey, id, "EX", 86_400);
    return id;
  },

  async upload(at, { name, mime, buffer, userId }) {
    const parent = await this.ensureFolder(at, userId);
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
};
