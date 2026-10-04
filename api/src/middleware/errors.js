import multer from "multer";
import { HttpError } from "../lib/errors.js";
import { UpstreamError } from "../providers/http.js";

export function notFound(_req, _res, next) {
  next(new HttpError(404, "Not found."));
}

export function errorHandler(err, req, res, _next) {
  let status = 500;
  let body = { error: "Something went wrong.", code: "internal" };

  if (err instanceof HttpError) {
    status = err.status;
    body = { error: err.message, code: err.code, ...(err.provider && { provider: err.provider }) };
  } else if (err instanceof multer.MulterError) {
    status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    body = { error: err.message, code: err.code.toLowerCase() };
  } else if (err instanceof UpstreamError) {
    status = 502;
    body = { error: "The storage provider returned an error.", code: "upstream" };
  } else if (/unsupported content type|multipart|boundary/i.test(err?.message ?? "")) {
    // busboy/multer reject malformed uploads with plain Errors; that's the client's fault, not ours.
    status = 400;
    body = { error: "Malformed upload. Send multipart/form-data.", code: "bad_upload" };
  } else if (err?.type === "entity.parse.failed") {
    status = 400;
    body = { error: "Malformed JSON body.", code: "bad_json" };
  }

  if (status >= 500) req.log?.error({ err }, "request failed");
  if (res.headersSent) return res.end();
  res.status(status).json(body);
}
