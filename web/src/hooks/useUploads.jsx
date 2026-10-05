import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, uploadFile } from "../lib/api";
import { withFolder } from "../lib/folderFiles";
import { CANCELLABLE, TRACKED } from "../lib/uploadStates";
import { keys } from "./queries";

const UploadContext = createContext(null);
const ACCEPT = /^image\//;
const DOCS = /\.(pdf|docx|txt|md)$/i;
const MAX_PARALLEL = 3;
const MAX_PREVIEWS = 40; // a 1,000-photo folder shouldn't decode 1,000 full-size previews
const supported = (f) => !f.name.startsWith(".") && (ACCEPT.test(f.type) || /\.(heic|heif)$/i.test(f.name) || DOCS.test(f.name));
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
  // Only applies while the item is still in one of `states` (a late poll or timer must not undo a cancel).
  const patchIf = useCallback(
    (id, states, p) => setItems((list) => list.map((it) => (it.id === id && states.includes(it.status) ? { ...it, ...p } : it))),
    []
  );
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const refreshData = useCallback(() => {
    qc.invalidateQueries({ queryKey: keys.files });
    qc.invalidateQueries({ queryKey: keys.storage });
  }, [qc]);

  // Accepts Files (from a picker; folder pickers set webkitRelativePath) or {file, folder} from a drop.
  // Returns how many were added; unsupported files (and hidden ones like .DS_Store) are skipped.
  const add = useCallback(
    (input) => {
      const entries = Array.from(input || []).map((x) => (x instanceof File ? withFolder(x) : x));
      const accepted = entries.filter((e) => supported(e.file));
      if (!accepted.length) return 0;
      const withPreviews = accepted.length <= MAX_PREVIEWS;
      setItems((list) => {
        const key = (e) => `${e.folder}/${e.file.name}:${e.file.size}`;
        const seen = new Set(list.filter((i) => i.status !== "error").map(key));
        const fresh = accepted
          .filter((e) => !seen.has(key(e)))
          .map(({ file, folder }) => {
            const id = ++seq;
            // HEIC and documents can't be previewed as images; the panel shows an icon instead.
            const previewable = withPreviews && !/heic|heif/i.test(file.type || file.name) && !DOCS.test(file.name);
            const preview = previewable ? URL.createObjectURL(file) : null;
            if (preview) previews.current.set(id, preview);
            return { id, file, folder, preview, status: "pending", progress: 0, provider };
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
        folder: item.folder,
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
              patchIf(item.id, ["waiting"], { status: "pending", progress: 0, error: undefined });
            }, (err.retryAfter || 15) * 1000);
            return;
          }
          patch(item.id, { status: err.code === "aborted" ? "cancelled" : "error", error: err.message });
        })
        .finally(() => controllers.current.delete(item.id));
    });
  }, [items, patch, patchIf]);

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
          patchIf(item.id, TRACKED, { status: "done", fileId: job.fileId });
        } else if (job.state === "failed") {
          patchIf(item.id, TRACKED, { status: "error", error: job.error || "Processing failed" });
        } else {
          // Server stages: queued → uploading (to the cloud) → indexing → finalizing.
          const map = { queued: "queued", uploading: "processing", indexing: "indexing", finalizing: "indexing" };
          patchIf(item.id, TRACKED, { status: map[job.stage] || "processing" });
        }
      });
      if (finished) refreshData();
    }, 1500);
    return () => clearInterval(timer);
    // tracking is derived from items; trackingKey captures membership changes.
  }, [trackingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
    Cancel one upload or many (ids). Not yet sent: dropped here. Sending: the request is aborted.
    Already on the server: its pipeline is stopped and anything it did is undone, including the
    copy in the cloud. Uploads that finished meanwhile stay as they are.
  */
  const cancel = useCallback(
    async (ids) => {
      const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
      const targets = itemsRef.current.filter((i) => wanted.has(i.id) && CANCELLABLE.includes(i.status));
      const onServer = [];
      for (const item of targets) {
        if (item.status === "uploading") controllers.current.get(item.id)?.abort();
        else if (item.jobId && TRACKED.includes(item.status)) onServer.push(item);
        else {
          started.current.add(item.id); // never start it
          patch(item.id, { status: "cancelled" });
        }
      }
      if (!onServer.length) return;
      onServer.forEach((i) => patch(i.id, { status: "cancelling" }));
      const results = {};
      try {
        // Batches of 500 keep each request small.
        for (let i = 0; i < onServer.length; i += 500) {
          const ids = onServer.slice(i, i + 500).map((it) => it.jobId);
          Object.assign(results, (await api("/jobs/cancel", { method: "POST", body: { ids } })).results);
        }
      } catch (err) {
        onServer.forEach((i) => patchIf(i.id, ["cancelling"], { status: "error", error: `Couldn't cancel: ${err.message}` }));
        return;
      }
      onServer.forEach((i) => patch(i.id, results[i.jobId] === "done" ? { status: "done" } : { status: "cancelled" }));
      refreshData();
    },
    [patch, patchIf, refreshData]
  );

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
