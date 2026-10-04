export class ApiError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

// Session cookie is httpOnly and same-origin; this header is the CSRF guard the API checks.
const CSRF = { "X-Requested-With": "omni" };

async function parse(res) {
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error || `Request failed (${res.status})`, body?.code, {
      provider: body?.provider,
      retryAfter: Number(res.headers.get("retry-after")) || undefined,
    });
  }
  return body;
}

// The only way the app talks to the backend: same-origin /api, cookie session, typed errors.
export async function api(path, { method = "GET", body, signal } = {}) {
  const headers = { ...CSRF };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return parse(res);
}

// XHR because fetch still cannot report upload progress.
export function uploadFile(file, { provider, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.withCredentials = true;
    Object.entries(CSRF).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else
        reject(
          new ApiError(xhr.status, body?.error || `Upload failed (${xhr.status})`, body?.code, {
            retryAfter: Number(xhr.getResponseHeader("retry-after")) || undefined,
          })
        );
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error during upload."));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled.", "aborted"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    const form = new FormData();
    form.append("provider", provider);
    form.append("files", file);
    xhr.send(form);
  });
}
