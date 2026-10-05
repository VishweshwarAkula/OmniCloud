import { FileDoc, FileMd, FilePdf, FileText } from "@phosphor-icons/react";
import { MatchBadge } from "../ui/MatchBadge";

const TYPES = {
  "application/pdf": { label: "PDF", Icon: FilePdf, tint: "text-[#ff7a6b]" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { label: "DOCX", Icon: FileDoc, tint: "text-[#6ea8ff]" },
  "text/markdown": { label: "MD", Icon: FileMd, tint: "text-mint" },
  "text/plain": { label: "TXT", Icon: FileText, tint: "text-mist" },
};

export const docType = (mime) => TYPES[mime] ?? { label: "DOC", Icon: FileText, tint: "text-mist" };

/** Wraps the query's words in <mark> so the matched passage is easy to spot. */
export function Highlight({ text, query }) {
  const terms = (query || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (!text || !terms.length) return text ?? null;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  return text.split(re).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="rounded bg-mint/20 px-0.5 text-fog">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

/** A document in the library grid or in search results (with the matched page + snippet). */
export function DocumentCard({ item, query, onOpen, compact = false }) {
  const t = docType(item.mime);
  const where = item.page ? `page ${item.page}` : item.pageCount ? `${item.pageCount} ${item.pageCount === 1 ? "page" : "pages"}` : null;
  return (
    <button
      onClick={() => onOpen(item)}
      className="group flex w-full flex-col gap-3 rounded-[1.25rem] bg-white/[0.03] p-4 text-left ring-1 ring-white/[0.07] transition duration-500 ease-[var(--ease-spring)] hover:bg-white/[0.05] hover:ring-white/20"
      aria-label={`Open ${item.title || item.name}`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] ring-1 ring-white/10">
          <t.Icon size={22} weight="light" className={t.tint} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{item.title || item.name}</p>
          <p className="mt-0.5 text-xs text-haze">
            {t.label}
            {where && ` · ${where}`}
          </p>
        </div>
        {item.match && <MatchBadge match={item.match} className="shrink-0" />}
      </div>
      {(item.snippet || (!compact && item.excerpt)) && (
        <p className="line-clamp-4 text-sm leading-relaxed text-mist">
          <Highlight text={item.snippet || item.excerpt} query={query} />
        </p>
      )}
    </button>
  );
}
