// Minimal Docker Engine API client, used through a socket proxy that only exposes /containers.
const BASE = (process.env.DOCKER_HOST || "http://docker-proxy:2375").replace(/^tcp:/, "http:");

async function docker(method, path, body, timeout = 30_000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok && res.status !== 304) throw new Error(`docker ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 || res.status === 304 ? null : res.json().catch(() => null);
}

export function listContainers(project, service, all = false) {
  const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`, `com.docker.compose.service=${service}`] });
  return docker("GET", `/containers/json?all=${all}&filters=${encodeURIComponent(filters)}`);
}

export const inspect = (id) => docker("GET", `/containers/${id}/json`);
export const start = (id) => docker("POST", `/containers/${id}/start`);
export const stop = (id, graceSeconds) => docker("POST", `/containers/${id}/stop?t=${graceSeconds}`, undefined, (graceSeconds + 30) * 1000);
export const remove = (id) => docker("DELETE", `/containers/${id}?v=false`);

// Creates a replica by cloning a running container of the same compose service, keeping its
// image, env, volumes, labels and network alias (so service DNS includes the new replica).
export async function cloneReplica(template, number) {
  const project = template.Config.Labels["com.docker.compose.project"];
  const service = template.Config.Labels["com.docker.compose.service"];
  const [network, endpoint] = Object.entries(template.NetworkSettings.Networks)[0];
  const aliases = [...new Set([service, ...(endpoint.Aliases || []).filter((a) => a === service)])];
  const name = `${project}-${service}-${number}`;

  const { Id: id } = await docker("POST", `/containers/create?name=${encodeURIComponent(name)}`, {
    Image: template.Config.Image,
    Cmd: template.Config.Cmd,
    Entrypoint: template.Config.Entrypoint,
    Env: template.Config.Env,
    WorkingDir: template.Config.WorkingDir,
    User: template.Config.User,
    Healthcheck: template.Config.Healthcheck,
    StopSignal: template.Config.StopSignal,
    StopTimeout: template.Config.StopTimeout,
    Labels: {
      ...template.Config.Labels,
      "com.docker.compose.container-number": String(number),
      "omni.autoscaled": "true",
    },
    // Published ports can't be shared between replicas.
    HostConfig: { ...template.HostConfig, PortBindings: {}, PublishAllPorts: false },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: aliases } } },
  });
  try {
    await start(id);
  } catch (err) {
    await remove(id).catch(() => {}); // don't leave half-created replicas behind
    throw err;
  }
  return { id, name };
}
