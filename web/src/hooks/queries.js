import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export const keys = {
  providers: ["providers"],
  storage: ["providers", "storage"],
  files: ["files"],
  search: (q) => ["search", q],
  bills: ["bills"],
};

export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: ({ signal }) => api("/providers", { signal }), select: (d) => d.providers });
}

export function useStorage(enabled = true) {
  return useQuery({ queryKey: keys.storage, queryFn: ({ signal }) => api("/providers/storage", { signal }), enabled, staleTime: 120_000 });
}

export function useConnectProvider() {
  return useMutation({
    mutationFn: (provider) => api(`/oauth/${provider}/start`, { method: "POST" }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

export function useDisconnectProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider) => api(`/providers/${provider}/disconnect`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.providers }),
  });
}

export function useFiles(tag, person) {
  return useInfiniteQuery({
    queryKey: [...keys.files, tag ?? null, person ?? null],
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) => {
      const qs = new URLSearchParams({ limit: "30" });
      if (pageParam) qs.set("cursor", pageParam);
      if (tag) qs.set("tag", tag);
      if (person) qs.set("person", person);
      return api(`/files?${qs}`, { signal });
    },
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useDeleteFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api(`/files/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.files });
      qc.invalidateQueries({ queryKey: ["search"] });
      qc.invalidateQueries({ queryKey: keys.bills });
      qc.invalidateQueries({ queryKey: keys.storage });
    },
  });
}

// Submit-driven: the query string in the URL is the single source of truth, and
// TanStack Query aborts superseded requests, so stale results can't overwrite fresh ones.
export function useSearch(q) {
  return useQuery({
    queryKey: keys.search(q),
    queryFn: ({ signal }) => api("/search", { method: "POST", body: { query: q, k: 30 }, signal }),
    enabled: Boolean(q),
    staleTime: 60_000,
  });
}

export function useBills() {
  return useQuery({ queryKey: keys.bills, queryFn: ({ signal }) => api("/bills/summary", { signal }) });
}

export function usePipeline() {
  return useQuery({
    queryKey: ["pipeline"],
    queryFn: ({ signal }) => api("/system/pipeline", { signal }),
    refetchInterval: 3_000,
    staleTime: 0,
  });
}

export function useTags() {
  return useQuery({ queryKey: [...keys.files, "tags"], queryFn: ({ signal }) => api("/files/tags", { signal }), select: (d) => d.tags, staleTime: 60_000 });
}

export function usePeople(all = false, hidden = false) {
  return useQuery({
    queryKey: ["people", all, hidden],
    queryFn: ({ signal }) => api(`/people?${new URLSearchParams({ ...(all && { all: "1" }), ...(hidden && { hidden: "1" }) })}`, { signal }),
    select: (d) => d.people,
  });
}

export function useUpdatePerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }) => api(`/people/${id}`, { method: "PATCH", body: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: keys.files });
    },
  });
}

export function useMergePeople() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ target, sources }) => api(`/people/${target}/merge`, { method: "POST", body: { sources } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["people"] });
      qc.invalidateQueries({ queryKey: keys.files });
    },
  });
}

export function useCapabilities() {
  return useQuery({ queryKey: ["capabilities"], queryFn: ({ signal }) => api("/system/capabilities", { signal }), staleTime: 60_000 });
}
