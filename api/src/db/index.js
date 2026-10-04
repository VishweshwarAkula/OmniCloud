import pg from "pg";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

// numeric → JS number (totals are small enough), bigint → number (file sizes).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// Keep `date` columns as 'YYYY-MM-DD' strings instead of local-midnight Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (err) => logger.error({ err: err.message }, "postgres pool error"));

export async function query(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

export async function one(text, params) {
  return (await query(text, params))[0] ?? null;
}

export const PROVIDER_IDS = { gdrive: 1, dropbox: 2, local: 3 };
export const PROVIDER_KEYS = { 1: "gdrive", 2: "dropbox", 3: "local" };
