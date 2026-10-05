import { ArrowClockwise, CheckCircle, CloudArrowUp, Copy, FileText, FolderSimplePlus, ImageSquare, Plus, WarningCircle, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useRef } from "react";
import { useProviders } from "../../hooks/queries";
import { useUploads } from "../../hooks/useUploads";
import { CANCELLABLE } from "../../lib/uploadStates";
import { easeSpring } from "../../lib/motion";
import { formatBytes } from "../../lib/format";
import { providerMeta } from "../ui/Brand";
import { Button } from "../ui/Button";

const STATUS = {
  pending: { label: "Waiting", tone: "text-haze" },
  waiting: { label: "Pipeline busy, retrying shortly", tone: "text-warn" },
  uploading: { label: "Uploading", tone: "text-aqua" },
  queued: { label: "Queued", tone: "text-mist" },
  processing: { label: "Saving to cloud", tone: "text-aqua" },
  indexing: { label: "Indexing", tone: "text-mint" },
  done: { label: "Done", tone: "text-ok", Icon: CheckCircle },
  duplicate: { label: "Already in library", tone: "text-warn", Icon: Copy },
  error: { label: "Failed", tone: "text-bad", Icon: WarningCircle },
  cancelling: { label: "Cancelling…", tone: "text-haze" },
  cancelled: { label: "Cancelled", tone: "text-haze" },
};

function Row({ item, onCancel, onRetry }) {
  const s = STATUS[item.status];
  const busy = ["uploading", "queued", "processing", "indexing", "waiting", "cancelling"].includes(item.status);
  const progress = item.status === "uploading" ? item.progress * 0.6 : { waiting: 0.05, queued: 0.65, processing: 0.75, indexing: 0.9 }[item.status] ?? 1;
  return (
    <li className="flex items-center gap-3 rounded-2xl p-2 transition hover:bg-white/[0.03]">
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/10">
        {item.preview ? (
          <img src={item.preview} alt="" className="h-full w-full object-cover" />
        ) : /\.(pdf|docx|txt|md)$/i.test(item.file.name) ? (
          <FileText size={20} weight="thin" className="absolute inset-0 m-auto text-mist" />
        ) : (
          <ImageSquare size={20} weight="thin" className="absolute inset-0 m-auto text-haze" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm" title={item.folder ? `${item.folder}/${item.file.name}` : item.file.name}>
          {item.folder && <span className="text-haze">{item.folder}/</span>}
          {item.file.name}
        </p>
        <p className={`mt-0.5 flex items-center gap-1.5 text-xs ${s.tone}`}>
          {s.Icon && <s.Icon size={12} weight="fill" />}
          {item.status === "error" ? item.error : s.label}
          <span className="text-haze">· {formatBytes(item.file.size)}</span>
        </p>
        {busy && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full origin-left rounded-full bg-gradient-to-r from-mint to-aqua transition-transform duration-700 ease-[var(--ease-spring)]"
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
        )}
      </div>
      {CANCELLABLE.includes(item.status) && (
        <button
          onClick={() => onCancel(item.id)}
          className="rounded-full p-2 text-haze transition hover:bg-white/5 hover:text-bad"
          aria-label={`Cancel ${item.file.name}`}
          title="Cancel this upload"
        >
          <X size={14} />
        </button>
      )}
      {(item.status === "error" || item.status === "cancelled") && (
        <button onClick={() => onRetry(item.id)} className="rounded-full p-2 text-haze transition hover:bg-white/5 hover:text-fog" aria-label={`Retry ${item.file.name}`}>
          <ArrowClockwise size={14} />
        </button>
      )}
    </li>
  );
}

export function UploadPanel() {
  const { items, add, cancel, retry, clearFinished, provider, setProvider, panelOpen, setPanelOpen } = useUploads();
  const { data: providers = [] } = useProviders();
  const input = useRef(null);
  const folderInput = useRef(null);
  const connected = providers.filter((p) => p.connected);
  const active = items.filter((i) => !["done", "duplicate", "error", "cancelled"].includes(i.status)).length;
  const cancellable = items.filter((i) => CANCELLABLE.includes(i.status));
  const cancelAll = () => {
    const onServer = cancellable.filter((i) => i.jobId).length;
    const warning = onServer
      ? `Cancel ${cancellable.length} uploads? ${onServer} already reached the server; anything they saved to your cloud will be removed.`
      : `Cancel ${cancellable.length} uploads?`;
    if (window.confirm(warning)) cancel(cancellable.map((i) => i.id));
  };
  const selectedConnected = connected.some((p) => p.key === provider);

  return (
    <AnimatePresence>
      {panelOpen && (
        <motion.aside
          aria-label="Uploads"
          className="glass fixed inset-x-3 bottom-24 z-30 flex max-h-[70dvh] flex-col rounded-[1.75rem] shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)] sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-[400px] lg:bottom-6"
          initial={{ opacity: 0, y: 30, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 30, scale: 0.97 }}
          transition={{ duration: 0.55, ease: easeSpring }}
        >
          <div className="flex items-center justify-between px-5 pb-3 pt-5">
            <div>
              <h2 className="font-semibold tracking-tight">Uploads</h2>
              <p className="text-xs text-mist">{active ? `${active} in progress` : items.length ? "All caught up" : "Drop photos or documents anywhere"}</p>
            </div>
            <div className="flex items-center gap-1">
              {cancellable.length > 1 && (
                <Button variant="quiet" size="sm" onClick={cancelAll}>
                  Cancel all
                </Button>
              )}
              <button onClick={() => setPanelOpen(false)} className="rounded-full p-2 text-mist transition hover:bg-white/5 hover:text-fog" aria-label="Close uploads">
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="px-5">
            <label className="mb-2 block text-[11px] uppercase tracking-[0.18em] text-haze" htmlFor="upload-provider">
              Save to
            </label>
            <div id="upload-provider" role="radiogroup" className="flex flex-wrap gap-2">
              {providers.map((p) => {
                const meta = providerMeta[p.key];
                return (
                  <button
                    key={p.key}
                    role="radio"
                    aria-checked={provider === p.key}
                    disabled={!p.connected}
                    onClick={() => setProvider(p.key)}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-xs ring-1 transition duration-300 disabled:opacity-40 ${
                      provider === p.key ? "bg-mint/10 text-fog ring-mint/40" : "text-mist ring-white/10 hover:ring-white/20"
                    }`}
                    title={p.connected ? undefined : `Connect ${meta.label} in Settings first`}
                  >
                    <meta.Icon size={14} weight="fill" className={meta.tint} />
                    {meta.label}
                  </button>
                );
              })}
            </div>
            {!selectedConnected && (
              <p className="mt-2 text-xs text-warn">
                {connected.length ? "Pick a connected destination." : "Connect a cloud in Settings first."}
              </p>
            )}
          </div>

          <ul className="mt-3 flex-1 space-y-1 overflow-y-auto px-3">
            {items.map((item) => (
              <Row key={item.id} item={item} onCancel={cancel} onRetry={retry} />
            ))}
          </ul>

          <div className="flex items-center gap-2 border-t border-white/[0.06] p-3">
            <input
              ref={input}
              type="file"
              accept="image/*,.heic,.heif,.pdf,.docx,.txt,.md"
              multiple
              hidden
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
            {/* webkitdirectory picks a whole folder; each File carries its path inside it. */}
            <input
              ref={folderInput}
              type="file"
              webkitdirectory=""
              multiple
              hidden
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
            <Button variant="primary" size="sm" leading={Plus} className="flex-1" disabled={!selectedConnected} onClick={() => input.current?.click()}>
              Add files
            </Button>
            <Button size="sm" leading={FolderSimplePlus} disabled={!selectedConnected} onClick={() => folderInput.current?.click()}>
              Add folder
            </Button>
            {items.length > active && (
              <Button variant="quiet" size="sm" onClick={clearFinished}>
                Clear done
              </Button>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

export function DropOverlay({ visible }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-ink/80 p-6 backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: easeSpring }}
        >
          <motion.div
            className="flex h-full max-h-[520px] w-full max-w-3xl flex-col items-center justify-center rounded-[2.5rem] border border-dashed border-mint/40 bg-mint/[0.03]"
            initial={{ scale: 0.95 }}
            animate={{ scale: 1 }}
            transition={{ duration: 0.5, ease: easeSpring }}
          >
            <CloudArrowUp size={56} weight="thin" className="text-mint" />
            <p className="mt-6 text-2xl font-medium tracking-tight">Drop to upload</p>
            <p className="mt-2 text-sm text-mist">Files or whole folders: photos and documents (PDF, DOCX, TXT, MD). Folders keep their structure in your cloud.</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
