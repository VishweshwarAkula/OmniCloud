import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import { requireCsrfHeader, requireLocalHost } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import filesRouter from "./routes/files.js";
import healthRouter from "./routes/health.js";
import mediaRouter from "./routes/media.js";
import peopleRouter from "./routes/people.js";
import providersRouter from "./routes/providers.js";
import uploadRouter from "./routes/upload.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind nginx / the Vite dev proxy

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/api/health" },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
    })
  );
  app.use(express.json({ limit: "100kb" }));

  const api = express.Router();
  api.use(requireLocalHost, requireCsrfHeader);
  api.use(healthRouter, providersRouter, uploadRouter, filesRouter, peopleRouter, mediaRouter);
  app.use("/api", api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
