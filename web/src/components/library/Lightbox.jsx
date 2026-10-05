import { ArrowSquareOut, Trash, X } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useDeleteFile } from "../../hooks/queries";
import { useToast } from "../../hooks/useToast";
import { formatBytes, formatDate } from "../../lib/format";
import { ProviderBadge } from "../ui/Brand";
import { matchLabel } from "../ui/MatchBadge";
import { docType, Highlight } from "./DocumentCard";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

export function Lightbox({ item, onClose, query }) {
  const [confirming, setConfirming] = useState(false);
  const del = useDeleteFile();
  const { toast } = useToast();
  const navigate = useNavigate();

  const close = () => {
    setConfirming(false);
    onClose();
  };

  const remove = (fromCloud) =>
    del.mutate({ id: item.id, fromCloud }, {
      onSuccess: () => {
        toast(fromCloud ? "Deleted from your cloud and OmniCloud." : "Removed from OmniCloud. The file is still in your cloud.", { tone: "success" });
        close();
      },
      onError: (err) => toast(err.message, { tone: "error" }),
    });

  return (
    <Modal open={Boolean(item)} onClose={close} size="xl" bare>
      {item && (
        <div className="bezel">
          <div className="bezel-core grid overflow-hidden lg:grid-cols-[1fr_320px]">
            <div className="relative flex max-h-[75dvh] min-h-[40dvh] items-center justify-center bg-black/40">
              {item.mediaType !== "document" ? (
                <motion.img layoutId={`media-${item.id}`} src={item.url} alt={item.name || ""} className="max-h-[75dvh] w-auto object-contain" />
              ) : item.mime === "application/pdf" ? (
                // The browser's own PDF viewer, opened at the matched page.
                <iframe title={item.title || item.name} src={`${item.url}#page=${item.page || 1}`} className="h-[75dvh] w-full bg-white" />
              ) : (
                <div className="h-full max-h-[75dvh] w-full overflow-y-auto p-8">
                  <p className="text-xs uppercase tracking-[0.18em] text-haze">
                    {item.snippet ? `Matched passage${item.page ? ` · page ${item.page}` : ""}` : "Beginning of the document"}
                  </p>
                  <p className="mt-4 whitespace-pre-line text-[15px] leading-relaxed text-fog">
                    <Highlight text={item.snippet || item.excerpt || "No text could be extracted."} query={query} />
                  </p>
                  <p className="mt-6 text-sm text-haze">Use “Open original” to read the whole document.</p>
                </div>
              )}
              <button onClick={close} className="absolute right-3 top-3 rounded-full bg-ink/80 p-2.5 text-fog ring-1 ring-white/10 lg:hidden" aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="flex flex-col gap-6 p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium" title={item.title || item.name}>{item.title || item.name || "Untitled"}</p>
                  <p className="mt-1 text-xs text-mist">{formatDate(item.createdAt)}</p>
                </div>
                <button onClick={close} className="hidden rounded-full p-2 text-mist transition hover:bg-white/5 hover:text-fog lg:block" aria-label="Close">
                  <X size={16} />
                </button>
              </div>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between"><dt className="text-haze">Stored in</dt><dd><ProviderBadge provider={item.provider} /></dd></div>
                {item.folder && <div className="flex justify-between gap-4"><dt className="text-haze">Folder</dt><dd className="truncate text-right font-mono text-xs" title={`OmniCloud/${item.folder}`}>OmniCloud/{item.folder}</dd></div>}
                {item.place && <div className="flex justify-between gap-4"><dt className="text-haze">Place</dt><dd className="truncate text-right" title={item.place}>{item.place}</dd></div>}
                {item.mediaType === "document" && (
                  <div className="flex justify-between"><dt className="text-haze">Document</dt><dd>{docType(item.mime).label}{item.pageCount ? ` · ${item.pageCount} pages` : ""}</dd></div>
                )}
                {item.mediaType !== "document" && item.kind && <div className="flex justify-between"><dt className="text-haze">Kind</dt><dd className="capitalize">{item.kind}</dd></div>}
                {item.takenAt && <div className="flex justify-between"><dt className="text-haze">Taken</dt><dd>{formatDate(item.takenAt, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</dd></div>}
                {item.camera && <div className="flex justify-between gap-4"><dt className="text-haze">Camera</dt><dd className="truncate">{item.camera}</dd></div>}
                {item.width && <div className="flex justify-between"><dt className="text-haze">Dimensions</dt><dd className="font-mono text-xs">{item.width} × {item.height}</dd></div>}
                <div className="flex justify-between"><dt className="text-haze">Size</dt><dd className="font-mono text-xs">{item.size ? formatBytes(item.size) : "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-haze">Type</dt><dd className="font-mono text-xs">{item.mime || "—"}</dd></div>
                {matchLabel(item.match) && <div className="flex justify-between"><dt className="text-haze">Match</dt><dd className="text-xs text-mint">{matchLabel(item.match)}</dd></div>}
                <div className="flex justify-between gap-4"><dt className="text-haze">Hash</dt><dd className="truncate font-mono text-[11px] text-mist" title={item.hash}>{item.hash?.slice(0, 16)}…</dd></div>
              </dl>
              {item.people?.length > 0 && (
                <div>
                  <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-haze">People</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {item.people.map((p) => (
                      <li key={p.id}>
                        <button
                          onClick={() => {
                            close();
                            navigate(`/app?person=${p.id}`);
                          }}
                          className="rounded-full bg-aqua/10 px-2.5 py-1 text-xs text-fog ring-1 ring-aqua/30 transition hover:bg-aqua/20"
                        >
                          {p.name || "Unnamed"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {item.tags?.length > 0 && (
                <div>
                  <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-haze">Detected</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {item.tags.map((t) => (
                      <li key={t}>
                        <button
                          onClick={() => {
                            close();
                            navigate(`/app?tag=${encodeURIComponent(t)}`);
                          }}
                          className="rounded-full bg-white/[0.04] px-2.5 py-1 text-xs text-mist ring-1 ring-white/10 transition hover:bg-mint/10 hover:text-fog hover:ring-mint/30"
                        >
                          {t}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-auto flex flex-col gap-2">
                <Button href={item.url} target="_blank" rel="noopener noreferrer" leading={ArrowSquareOut}>Open original</Button>
                {confirming ? (
                  <div className="flex flex-col gap-2 rounded-2xl bg-white/[0.03] p-3 ring-1 ring-white/10">
                    <p className="text-xs text-mist">Remove this file from OmniCloud, or delete it from your cloud too?</p>
                    <Button loading={del.isPending && !del.variables?.fromCloud} disabled={del.isPending} onClick={() => remove(false)}>
                      Remove from OmniCloud
                    </Button>
                    <Button variant="danger" loading={del.isPending && del.variables?.fromCloud} disabled={del.isPending} onClick={() => remove(true)}>
                      Delete from cloud too
                    </Button>
                    <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
                  </div>
                ) : (
                  <Button variant="quiet" leading={Trash} onClick={() => setConfirming(true)}>Delete</Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
