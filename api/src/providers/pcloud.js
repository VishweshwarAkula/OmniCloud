import { config } from "../config.js";
import { form, request, requestJson, UpstreamError } from "./http.js";

// pCloud: OAuth 2 (tokens don't expire). Accounts live in a US or EU data centre, and the OAuth
// callback says which (`hostname`), so the stored credential is {token, host}.
const FOLDER = "/OmniCloud";
const redirectUri = () => `${config.PUBLIC_URL}/api/oauth/pcloud/callback`;
const parse = (cred) => (typeof cred === "string" ? JSON.parse(cred) : cred);
const VALID_HOSTS = new Set(["api.pcloud.com", "eapi.pcloud.com"]);

// pCloud reports most errors as HTTP 200 with a non-zero `result`.
async function call(cred, method, params = {}, init = {}) {
  const { token, host } = parse(cred);
  const url = `https://${host}/${method}?${new URLSearchParams(params)}`;
  const data = await requestJson(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (data.result !== 0) {
    // 1000/2000/2094/2095 = not logged in / invalid or expired token → treat like a 401 (reconnect).
    const status = [1000, 2000, 2094, 2095].includes(data.result) ? 401 : data.result === 2009 ? 404 : 400;
    throw new UpstreamError(status, `pCloud error ${data.result}: ${data.error}`, url);
  }
  return data;
}

// /OmniCloud/<folder…>: pCloud only creates one level per call.
async function folderId(cred, folder = []) {
  let path = FOLDER;
  let data = await call(cred, "createfolderifnotexists", { path });
  for (const level of folder) {
    path += `/${level}`;
    data = await call(cred, "createfolderifnotexists", { path });
  }
  return data.metadata.folderid;
}

async function fetchLink(cred, method, params) {
  const data = await call(cred, method, params);
  return request(`https://${data.hosts[0]}${data.path}`);
}

export const pcloud = {
  key: "pcloud",
  label: "pCloud",

  authorizeUrl(state) {
    const params = new URLSearchParams({ client_id: config.PCLOUD_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(), state });
    return `https://my.pcloud.com/oauth2/authorize?${params}`;
  },

  async exchangeCode(code, query = {}) {
    const host = VALID_HOSTS.has(query.hostname) ? query.hostname : "api.pcloud.com";
    const data = await requestJson(`https://${host}/oauth2_token`, {
      method: "POST",
      body: form({ client_id: config.PCLOUD_CLIENT_ID, client_secret: config.PCLOUD_CLIENT_SECRET, code }),
    });
    if (!data.access_token) throw new UpstreamError(400, `pCloud token exchange failed: ${data.error}`, `https://${host}`);
    return { refreshToken: JSON.stringify({ token: data.access_token, host }) };
  },

  // Non-expiring token: the stored credential is used as-is.
  static: true,

  async revoke() {
    // pCloud has no token-revocation endpoint; access can be removed in pCloud's settings.
  },

  async quota(cred) {
    const u = await call(cred, "userinfo");
    return { total: u.quota, used: u.usedquota, free: Math.max(0, u.quota - u.usedquota) };
  },

  async upload(cred, { name, folder, mime, buffer }) {
    const body = new FormData();
    body.set("file", new Blob([buffer], { type: mime }), name);
    const data = await call(cred, "uploadfile", { folderid: await folderId(cred, folder), filename: name, nopartial: 1, renameifexists: 1 }, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(120_000),
    });
    const meta = data.metadata[0];
    return { id: String(meta.fileid), name: meta.name };
  },

  media: (cred, fileId) => fetchLink(cred, "getfilelink", { fileid: fileId }),

  async thumbnail(cred, fileId) {
    try {
      return await fetchLink(cred, "getthumblink", { fileid: fileId, size: "640x640" });
    } catch {
      return this.media(cred, fileId); // documents and unusual formats have no thumbnail
    }
  },

  async remove(cred, fileId) {
    try {
      await call(cred, "deletefile", { fileid: fileId });
    } catch (err) {
      if (!(err instanceof UpstreamError && err.status === 404)) throw err;
    }
  },

  async removeEmptyFolder(cred, _userId, folder) {
    const path = [FOLDER, ...folder].join("/");
    let data;
    try {
      data = await call(cred, "listfolder", { path });
    } catch (err) {
      if (err instanceof UpstreamError && (err.status === 404 || err.status === 400)) return false;
      throw err;
    }
    if (data.metadata.contents?.length) return false;
    await call(cred, "deletefolder", { path });
    return true;
  },
};
