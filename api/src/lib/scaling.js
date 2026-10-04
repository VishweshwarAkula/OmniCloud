// replicas needed so each handles ~targetPerReplica queued jobs, within [min, max].
export function desiredReplicas(backlog, targetPerReplica, min, max) {
  return Math.min(max, Math.max(min, Math.ceil(backlog / Math.max(1, targetPerReplica))));
}
