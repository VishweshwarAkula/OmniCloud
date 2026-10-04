import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { ensureBloom, redis } from "./lib/redis.js";
import { pool } from "./db/index.js";
import { closeQueues } from "./queues/index.js";

await ensureBloom();

const server = createApp().listen(config.PORT, () => logger.info(`api listening on :${config.PORT}`));

async function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  server.close();
  await Promise.allSettled([closeQueues(), redis.quit(), pool.end()]);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
