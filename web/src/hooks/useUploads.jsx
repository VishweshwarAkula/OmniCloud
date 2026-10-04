import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, uploadFile } from "../lib/api";
import { keys } from "./queries";

const UploadContext = createContext(null);
const ACCEPT = /^image\//;
const MAX_PARALLEL = 3;
let seq = 0;

/*
  Item lifecycle: pending → uploading (progress 0..1) → queued → uploading-to-cloud → indexing → done
  plus terminal states: duplicate | error. Server-side stages come from polling /api/jobs/:id.
*/
export function UploadProvider({ children }) {
  const qc = useQueryClient();
  const [items, setItems] = useState([]);
  const [provider, setProvider] = useState("gdrive");
  const [panelOpen, setPanelOpen] = useState(false);
  const controllers = useRef(new Map());
  const previews = useRef(new Map());
  const started = useRef(new Set()); // guards against double-starts (StrictMode re-runs effects)

  const patch = useCallback((id, p) => setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it))), []);

  const refreshData = useCallback(() => {
    qc.invalidateQueries({ queryKey: keys.files });
    qc.invalidateQueries({ queryKey: keys.bills });
    qc.invalidateQueries({ queryKey: keys.storage });
  }, [qc]);

  const add = useCallback(
    (fileList) => {
      const files = Array.from(fileList || []);
      const accepted = files.filter((f) => ACCEPT.test(f.type) || /\.(heic|heif)$/i.test(f.name));
      if (!accepted.length) return 0;
      setItems((list) => {
        const seen = new Set(list.filter((i) => i.status !== "error").map((i) => `${i.file.name}:${i.file.size}`));
        const fresh = accepted
          .filter((f) => !seen.has(`${f.name}:${f.size}`))
          .map((file) => {
            const id = ++seq;
            // HEIC can't be previewed in most browsers; the grid falls back to an icon.
            const preview = /heic|heif/i.test(file.type || file.name) ? null : URL.createObjectURL(file);
            if (preview) previews.current.set(id, preview);
            return { id, file, preview, status: "pending", progress: 0, provider };
          });
        return [...list, ...fresh];
      });
      setPanelOpen(true);
      return accepted.length;
    },
    [provider]
  );

  // Start uploads, at most MAX_PARALLEL at a time.
  useEffect(() => {
    const active = items.filter((i) => i.status === "uploading").length;
    const next = items
      .filter((i) => i.status === "pending" && !started.current.has(i.id))
      .slice(0, Math.max(0, MAX_PARALLEL - active));
    next.forEach((item) => {
      started.current.add(item.id);
      const ctrl = new AbortController();
      controllers.current.set(item.id, ctrl);
      patch(item.id, { status: "uploading" });
      uploadFile(item.file, {
        provider: item.provider,
        signal: ctrl.signal,
        onProgress: (p) => patch(item.id, { progress: p }),
      })
        .then(({ results }) => {
          const r = results?.[0];
          if (!r) throw new Error("No result");
          patch(item.id, r.status === "duplicate" ? { status: "duplicate", progress: 1 } : { status: "queued", progress: 1, jobId: r.jobId });
        })
        .catch((err) => {
          if (err.status === 503 || err.status === 429) {
            // Backpressure: the pipeline is full. Wait and requeue instead of failing.
            patch(item.id, { status: "waiting", error: "Pipeline busy, retrying shortly" });
            setTimeout(() => {
              started.current.delete(item.id);
              patch(item.id, { status: "pending", progress: 0, error: undefined });
            }, (err.retryAfter || 15) * 1000);
            return;
          }
          patch(item.id, { status: err.code === "aborted" ? "cancelled" : "error", error: err.message });
        })
        .finally(() => controllers.current.delete(item.id));
    });
  }, [items, patch]);

  // Poll server-side job state for anything in flight.
  const tracking = items.filter((i) => i.jobId && ["queued", "processing", "indexing"].includes(i.status));
  const trackingKey = tracking.map((i) => i.id).join(",");
  useEffect(() => {
    if (!trackingKey) return;
    const timer = setInterval(async () => {
      const results = await Promise.allSettled(tracking.map((i) => api(`/jobs/${i.jobId}`)));
      let finished = false;
      results.forEach((res, idx) => {
        const item = tracking[idx];
        if (res.status !== "fulfilled") return;
        const job = res.value;
        if (job.state === "completed") {
          finished = true;
          patch(item.id, { status: "done", fileId: job.fileId });
        } else if (job.state === "failed") {
          patch(item.id, { status: "error", error: job.error || "Processing failed" });
        } else {
          // Server stages: queued → uploading (to the cloud) → indexing → finalizing.
          const map = { queued: "queued", uploading: "processing", indexing: "indexing", finalizing: "indexing" };
          patch(item.id, { status: map[job.stage] || "processing" });
        }
      });
      if (finished) refreshData();
    }, 1500);
    return () => clearInterval(timer);
    // tracking is derived from items; trackingKey captures membership changes.
  }, [trackingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = useCallback((id) => controllers.current.get(id)?.abort(), []);

  const retry = useCallback((id) => {
    started.current.delete(id);
    patch(id, { status: "pending", progress: 0, error: undefined, jobId: undefined });
  }, [patch]);

  const clearFinished = useCallback(() => {
    setItems((list) => {
      const keep = list.filter((i) => !["done", "duplicate", "error", "cancelled"].includes(i.status));
      list.filter((i) => !keep.includes(i)).forEach((i) => {
        const url = previews.current.get(i.id);
        if (url) URL.revokeObjectURL(url);
        previews.current.delete(i.id);
      });
      return keep;
    });
  }, []);

  useEffect(() => {
    const map = previews.current;
    const ctrls = controllers.current;
    return () => {
      map.forEach((url) => URL.revokeObjectURL(url));
      ctrls.forEach((c) => c.abort());
    };
  }, []);

  const value = useMemo(
    () => ({ items, add, cancel, retry, clearFinished, provider, setProvider, panelOpen, setPanelOpen }),
    [items, add, cancel, retry, clearFinished, provider, panelOpen]
  );
  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUploads() {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUploads must be used inside <UploadProvider>");
  return ctx;
}
