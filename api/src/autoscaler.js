/*
  Queue-driven autoscaler (KEDA-style) for docker compose.

  Every TICK it reads queue depth per rule and computes
      desired = clamp(ceil(backlog / targetPerReplica), min, max)
  - scale up quickly (at most +STEP per tick, short cooldown) — bursts of uploads
  - scale down slowly (one replica at a time, only after the backlog has stayed low
    for SCALE_DOWN_DELAY) — avoids flapping; workers drain in-flight jobs on SIGTERM.
  Only replicas it created are removed, so the compose-defined baseline is never touched.
*/
import { config as _config } from "./config.js"; // validates env early
import { cloneReplica, inspect, listContainers, remove, stop } from "./lib/docker.js";
import { logger } from "./lib/logger.js";
import { redis } from "./lib/redis.js";
import { desiredReplicas } from "./lib/scaling.js";
import { closeQueues, queueBacklog } from "./queues/index.js";

void _config;
const num = (name, fallback) => Number(process.env[name] ?? fallback);
const PROJECT = process.env.COMPOSE_PROJECT || "omnicloud-app";
const TICK = num("SCALE_TICK_MS", 5_000);
const STEP = num("SCALE_STEP", 2);
const UP_COOLDOWN = num("SCALE_UP_COOLDOWN_MS", 15_000);
const DOWN_DELAY = num("SCALE_DOWN_DELAY_MS", 90_000);

const rules = [
  {
    service: "worker",
    queues: ["upload", "embed", "faces", "finalize"],
    target: num("WORKER_TARGET_BACKLOG", 20),
    min: num("WORKER_MIN", 1),
    max: num("WORKER_MAX", 8),
    grace: num("WORKER_STOP_GRACE_S", 120),
  },
  {
    service: "ml",
    queues: ["embed", "faces"],
    target: num("ML_TARGET_BACKLOG", 10),
    min: num("ML_MIN", 1),
    max: num("ML_MAX", 3),
    grace: num("ML_STOP_GRACE_S", 30),
  },
];

const state = Object.fromEntries(rules.map((r) => [r.service, { lastUp: 0, lowSince: null, draining: new Set() }]));

const numberOf = (c) => Number(c.Labels["com.docker.compose.container-number"] || 0);

async function reconcile(rule, backlogByQueue) {
  const st = state[rule.service];
  const backlog = rule.queues.reduce((s, q) => s + (backlogByQueue[q] || 0), 0);
  const running = (await listContainers(PROJECT, rule.service)).filter((c) => !st.draining.has(c.Id));
  const current = running.length;
  const desired = desiredReplicas(backlog, rule.target, rule.min, rule.max);
  const now = Date.now();

  await redis.hset("omni:scale", rule.service, JSON.stringify({ current, desired, backlog, min: rule.min, max: rule.max, at: now }));

  if (!current) {
    logger.warn({ service: rule.service }, "no running replica to use as a template; is the service up?");
    return;
  }

  if (desired > current && now - st.lastUp >= UP_COOLDOWN) {
    st.lowSince = null;
    st.lastUp = now;
    const template = await inspect(running[0].Id);
    const all = await listContainers(PROJECT, rule.service, true);
    let next = Math.max(...all.map(numberOf), 0);
    const add = Math.min(STEP, desired - current);
    for (let i = 0; i < add; i++) {
      const { name } = await cloneReplica(template, ++next);
      logger.info({ service: rule.service, name, backlog, from: current, to: current + i + 1 }, "scaled up");
    }
    return;
  }

  if (desired < current) {
    st.lowSince ??= now;
    if (now - st.lowSince < DOWN_DELAY) return;
    const victim = running.filter((c) => c.Labels["omni.autoscaled"] === "true").sort((a, b) => numberOf(b) - numberOf(a))[0];
    if (!victim) return;
    st.draining.add(victim.Id);
    st.lowSince = now; // one replica per DOWN_DELAY window
    logger.info({ service: rule.service, name: victim.Names[0], backlog, from: current, to: current - 1 }, "scaling down (draining)");
    // Stop sends SIGTERM; the worker finishes in-flight jobs before exiting.
    stop(victim.Id, rule.grace)
      .then(() => remove(victim.Id))
      .catch((err) => logger.error({ err: err.message }, "scale-down failed"))
      .finally(() => st.draining.delete(victim.Id));
    return;
  }

  st.lowSince = null;
}

let timer;
async function tick() {
  try {
    const backlog = await queueBacklog();
    for (const rule of rules) await reconcile(rule, backlog).catch((err) => logger.error({ service: rule.service, err: err.message }, "reconcile failed"));
  } catch (err) {
    logger.error({ err: err.message }, "autoscaler tick failed");
  } finally {
    timer = setTimeout(tick, TICK);
  }
}

logger.info({ project: PROJECT, rules: rules.map(({ service, min, max, target }) => ({ service, min, max, target })) }, "autoscaler started");
tick();

async function shutdown() {
  clearTimeout(timer);
  await Promise.allSettled([closeQueues(), redis.quit()]);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
