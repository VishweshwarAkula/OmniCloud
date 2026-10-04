import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.NODE_ENV === "test" ? "silent" : config.LOG_LEVEL,
  redact: ["req.headers.authorization", "req.headers.cookie"],
  ...(config.NODE_ENV === "development" && {
    transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  }),
});
