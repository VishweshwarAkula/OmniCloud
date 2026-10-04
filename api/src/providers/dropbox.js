import { config } from "../config.js";
import { form, request, requestJson, UpstreamError } from "./http.js";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const FOLDER = "/OmniCloud";

const redirectUri = () => `${config.PUBLIC_URL}/api/oauth/dropbox/callback`;
const auth = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });
// Dropbox-API-Arg must be ASCII; escape anything else as \uXXXX.
const apiArg = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const clientCreds = () => ({ client_id: config.DROPBOX_CLIENT_ID, client_secret: config.DROPBOX_CLIENT_SECRET });

export const dropbox = {
  key: "dropbox",
  label: "Dropbox",

  authorizeUrl(state) {
    const params = new URLSearchParams({
      client_id: config.DROPBOX_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: "code",
      token_access_type: "offline",
      state,
    });
    return `https://www.dropbox.com/oauth2/authorize?${params}`;
  },

  async exchangeCode(code) {
    const data = await requestJson("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      body: form({ code, grant_type: "authorization_code", redirect_uri: redirectUri(), ...clientCreds() }),
    });
    return { refreshToken: data.refresh_token, accessToken: data.access_token, expiresIn: data.expires_in };
  },

  async refresh(refreshToken) {
    const data = await requestJson("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      body: form({ grant_type: "refresh_token", refresh_token: refreshToken, ...clientCreds() }),
    });
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  },

  async revoke(refreshToken) {
    const { accessToken } = await this.refresh(refreshToken);
    await request(`${API}/auth/token/revoke`, { method: "POST", headers: auth(accessToken) });
  },

  async quota(at) {
    const s = await requestJson(`${API}/users/get_space_usage`, { method: "POST", headers: auth(at) });
    const total = s.allocation?.allocated || 0;
    const used = s.used || 0;
    return { total, used, free: Math.max(0, total - used) };
  },

  async upload(at, { name, buffer }) {
    const file = await requestJson(`${CONTENT}/files/upload`, {
      method: "POST",
      headers: {
        ...auth(at),
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": apiArg({ path: `${FOLDER}/${name}`, mode: "add", autorename: true, mute: true }),
      },
      body: buffer,
      signal: AbortSignal.timeout(120_000),
    });
    return { id: file.id, name: file.name };
  },

  media(at, fileId) {
    return request(`${CONTENT}/files/download`, {
      method: "POST",
      headers: { ...auth(at), "Dropbox-API-Arg": apiArg({ path: fileId }) },
    });
  },

  thumbnail(at, fileId) {
    return request(`${CONTENT}/files/get_thumbnail_v2`, {
      method: "POST",
      headers: {
        ...auth(at),
        "Dropbox-API-Arg": apiArg({ resource: { ".tag": "path", path: fileId }, format: "jpeg", size: "w640h480", mode: "bestfit" }),
      },
    });
  },

  async remove(at, fileId) {
    try {
      await requestJson(`${API}/files/delete_v2`, {
        method: "POST",
        headers: { ...auth(at), "Content-Type": "application/json" },
        body: JSON.stringify({ path: fileId }),
      });
    } catch (err) {
      if (!(err instanceof UpstreamError && err.status === 409)) throw err;
    }
  },
};
