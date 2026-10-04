import { CalendarBlank, Eye, MagicWand, MagnifyingGlass, MapPin, SmileyBlank, Tag, User } from "@phosphor-icons/react";
import { formatDate } from "../../lib/format";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { GridSkeleton, ImageGrid } from "../../components/library/ImageGrid";
import { Lightbox } from "../../components/library/Lightbox";
import { Button } from "../../components/ui/Button";
import { EmptyState, ErrorState } from "../../components/ui/Feedback";
import { useSearch } from "../../hooks/queries";
import { PageHeader } from "./PageHeader";

const IDEAS = ["beach last summer", "screenshots from last week", "receipts", "sunset", "food in december", "people smiling"];

function Understood({ u, reranked }) {
  if (!u) return null;
  const chips = [];
  if (u.visual) chips.push({ Icon: Eye, label: `“${u.visual}”` });
  if (u.dateFrom) {
    const same = u.dateFrom === u.dateTo;
    chips.push({ Icon: CalendarBlank, label: same ? formatDate(u.dateFrom) : `${formatDate(u.dateFrom)} – ${formatDate(u.dateTo)}` });
  }
  u.months?.forEach((m) => chips.push({ Icon: CalendarBlank, label: `${new Date(2000, m - 1, 1).toLocaleDateString(undefined, { month: "long" })}, any year` }));
  u.places?.forEach((p) => chips.push({ Icon: MapPin, label: p }));
  u.people?.forEach((p) => chips.push({ Icon: User, label: p }));
  u.kinds?.forEach((k) => chips.push({ Icon: Tag, label: k }));
  if (!chips.length) return null;
  const via = { gemini: "Gemini", local: "on-device rules", none: "fallback" }[u.source] ?? u.source;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 text-sm" aria-label="How the search was understood">
      <span className="text-haze">Understood as</span>
      {chips.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-3 py-1 text-mist ring-1 ring-white/10">
          <c.Icon size={13} weight="light" className="text-mint" />
          {c.label}
        </span>
      ))}
      <span className="text-xs text-haze">
        via {via}
        {reranked && (
          <>
            {" · "}
            <MagicWand size={11} className="inline" /> re-ranked {reranked === "gemini" ? "by Gemini" : "on-device"}
          </>
        )}
      </span>
    </div>
  );
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q")?.trim() || "";
  const [draft, setDraft] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  const [open, setOpen] = useState(null);
  const search = useSearch(q);

  // Keep the input in sync when the query changes from elsewhere (⌘K palette, back button).
  if (q !== lastQ) {
    setLastQ(q);
    setDraft(q);
  }

  const submit = (value) => {
    const v = value.trim();
    setParams(v ? { q: v } : {});
  };

  const items = search.data?.items ?? [];

  return (
    <>
      <PageHeader eyebrow="Semantic search" title="Describe it. We'll find it.">
        Ask like you would a friend: “Priya at the beach in Goa last summer”. Dates, places and people become filters, SigLIP 2 finds what&apos;s in the picture, and the best results get a second look.
      </PageHeader>

      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
        className="bezel mb-10 max-w-3xl rounded-full"
      >
        <div className="bezel-core flex items-center gap-3 rounded-full py-1.5 pl-6 pr-1.5">
          <MagnifyingGlass size={20} weight="light" className="shrink-0 text-mist" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="“whiteboard from Tuesday’s meeting”"
            aria-label="Search query"
            className="h-12 w-full bg-transparent text-base outline-none placeholder:text-haze"
            maxLength={300}
          />
          <Button type="submit" variant="primary" disabled={!draft.trim()}>Search</Button>
        </div>
      </form>

      {!q ? (
        <div className="flex flex-wrap gap-2">
          {IDEAS.map((idea) => (
            <button key={idea} onClick={() => submit(idea)} className="rounded-full px-4 py-2 text-sm text-mist ring-1 ring-white/10 transition duration-500 ease-[var(--ease-spring)] hover:bg-white/[0.04] hover:text-fog">
              {idea}
            </button>
          ))}
        </div>
      ) : search.isPending ? (
        <GridSkeleton count={8} />
      ) : search.isError ? (
        <ErrorState error={search.error} onRetry={() => search.refetch()} />
      ) : !items.length ? (
        <>
        <Understood u={search.data?.understood} reranked={search.data?.reranked} />
        <EmptyState icon={SmileyBlank} title={`Nothing like “${q}” yet`}>
          Try a broader description. Newly uploaded images become searchable a few seconds after indexing.
        </EmptyState>
        </>
      ) : (
        <>
          <Understood u={search.data?.understood} reranked={search.data?.reranked} />
          <p className="mb-5 text-sm text-mist">
            {items.length} best {items.length === 1 ? "match" : "matches"} for <span className="text-fog">“{q}”</span>
          </p>
          <ImageGrid items={items} onOpen={setOpen} />
        </>
      )}

      <Lightbox item={open} onClose={() => setOpen(null)} />
    </>
  );
}
