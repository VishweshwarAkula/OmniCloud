export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The user's provider grant was revoked or expired; the client should prompt a reconnect.
export class ProviderAuthError extends HttpError {
  constructor(provider) {
    super(401, `Your ${provider} connection expired. Please reconnect it.`, "provider_reauth");
    this.provider = provider;
  }
}

export const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
