import { z } from "zod";

// zod 4 returns .default() values as-is (no transform), so boolean defaults must be booleans.
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default("info"),

  // Browser-facing origin of the app (nginx in prod, Vite in dev). OAuth redirects are built from it.
  PUBLIC_URL: z.url().default("http://localhost:8080"),

  DATABASE_URL: z.string().default("postgres://omni:omni@postgres:5432/omni"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
  // Local-only shortcut: sign in with just an email (no Google). Never enable on a shared host.
  DEV_LOGIN: bool.default(false),

  REDIS_URL: z.string().default("redis://redis:6379"),
  BLOOM_ENABLED: bool.default(true),

  ML_URL: z.url().default("http://ml:8000"),
  ML_SERVICE_TOKEN: z.string().default(""),
  // Shared with the ML service: when no Gemini key is set, the OCR stage is skipped entirely.
  GOOGLE_API_KEY: z.string().default(""),
  // local | off. Faces run on this machine only (biometric data never leaves it).
  FACES_MODE: z.enum(["local", "off"]).default("local"),
  // auto | api | local — Gemini looks at the top thumbnails when available, otherwise local re-ranking.
  RERANK_MODE: z.enum(["auto", "api", "local", "off"]).default("auto"),
  RERANK_TOP_N: z.coerce.number().int().min(2).max(24).default(12),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  DROPBOX_CLIENT_ID: z.string().optional(),
  DROPBOX_CLIENT_SECRET: z.string().optional(),

  // 32 bytes, base64 or hex. Encrypts provider refresh tokens at rest.
  TOKEN_ENC_KEY: z.string().min(32),
  // Signs short-lived media URLs used by <img src>.
  URL_SIGNING_SECRET: z.string().min(32),

  UPLOAD_DIR: z.string().default("/data/uploads"),
  // "Local disk" storage provider: keeps files on this server. Set false to offer only cloud providers.
  LOCAL_STORAGE: bool.default(true),
  LIBRARY_DIR: z.string().default("/data/library"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(25),
  // Per-user upload requests per minute (the UI sends one request per file). Queue backpressure
  // (MAX_QUEUE_BACKLOG) is the real overload guard; this only stops runaway clients.
  UPLOAD_RATE_PER_MINUTE: z.coerce.number().int().positive().default(600),
  MAX_FILES_PER_UPLOAD: z.coerce.number().int().positive().default(20),
  // Per-replica concurrency for each pipeline stage (replicas are added by the autoscaler).
  UPLOAD_CONCURRENCY: z.coerce.number().int().positive().default(6),
  EMBED_CONCURRENCY: z.coerce.number().int().positive().default(2),
  OCR_CONCURRENCY: z.coerce.number().int().positive().default(4),
  FINALIZE_CONCURRENCY: z.coerce.number().int().positive().default(8),
  OCR_RATE_PER_MINUTE: z.coerce.number().int().positive().default(60),
  // Upload requests are refused (503 + Retry-After) above this many queued jobs.
  MAX_QUEUE_BACKLOG: z.coerce.number().int().positive().default(5000),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const config = load();

export const ocrEnabled = Boolean(config.GOOGLE_API_KEY);
export const facesEnabled = config.FACES_MODE !== "off";

export const secureCookies = config.PUBLIC_URL.startsWith("https://");

export const googleLoginConfigured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);

export const providerConfigured = {
  gdrive: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
  dropbox: Boolean(config.DROPBOX_CLIENT_ID && config.DROPBOX_CLIENT_SECRET),
  local: config.LOCAL_STORAGE,
};
