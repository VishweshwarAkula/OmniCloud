// Applies migrations/*.sql in order, once each, inside a transaction.
// An advisory lock makes concurrent runs (several replicas booting) safe.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger.js";
import { pool } from "./index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(727274)");
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
        logger.info({ file }, "migration applied");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => {
      logger.info("database is up to date");
      return pool.end();
    })
    .catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
}
