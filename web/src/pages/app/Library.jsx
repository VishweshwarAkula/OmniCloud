import { CloudArrowUp, Plugs } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { GridSkeleton, ImageGrid } from "../../components/library/ImageGrid";
import { Lightbox } from "../../components/library/Lightbox";
import { Button } from "../../components/ui/Button";
import { EmptyState, ErrorState } from "../../components/ui/Feedback";
import { useFiles, usePeople, useProviders, useTags } from "../../hooks/queries";
import { FaceThumb } from "../../components/ui/FaceThumb";
import { useUploads } from "../../hooks/useUploads";
import { PageHeader } from "./PageHeader";

export default function Library() {
  const [params, setParams] = useSearchParams();
  const tag = params.get("tag") || undefined;
  const person = params.get("person") || undefined;
  const files = useFiles(tag, person);
  const { data: people = [] } = usePeople(true);
  const personInfo = person ? people.find((p) => p.id === person) : null;
  const { data: tags = [] } = useTags();
  const { data: providers } = useProviders();
  const { setPanelOpen } = useUploads();
  const [open, setOpen] = useState(null);
  const sentinel = useRef(null);
  const items = files.data?.pages.flatMap((p) => p.items) ?? [];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = files;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && !isFetchingNextPage && fetchNextPage(), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const noProviders = providers && !providers.some((p) => p.connected);

  return (
    <>
      <PageHeader
        eyebrow="Library"
        title="Everything, one surface"
        actions={!noProviders && <Button variant="primary" leading={CloudArrowUp} onClick={() => setPanelOpen(true)}>Upload</Button>}
      >
        Images from every connected cloud, newest first. Drop files anywhere on this page to add more.
      </PageHeader>

      {person && (
        <div className="mb-8 inline-flex items-center gap-3 rounded-full bg-white/[0.04] py-1.5 pl-1.5 pr-2 ring-1 ring-white/10">
          <FaceThumb cover={personInfo?.cover} size="32px" className="rounded-full" />
          <span className="text-sm">Photos of <span className="text-fog">{personInfo?.name || "this person"}</span></span>
          <button onClick={() => setParams({})} className="rounded-full p-1 text-haze hover:text-fog" aria-label="Clear person filter">✕</button>
        </div>
      )}

      {!person && tags.length > 0 && (
        <nav aria-label="Filter by tag" className="-mx-4 mb-8 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {[{ tag: undefined, label: "All" }, ...tags.map((t) => ({ tag: t.tag, label: t.tag, count: t.count }))].map((c) => {
            const active = c.tag === tag;
            return (
              <button
                key={c.label}
                onClick={() => setParams(c.tag ? { tag: c.tag } : {})}
                aria-pressed={active}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm ring-1 transition duration-500 ease-[var(--ease-spring)] ${
                  active ? "bg-mint/10 text-fog ring-mint/40" : "text-mist ring-white/10 hover:bg-white/[0.04] hover:text-fog"
                }`}
              >
                {c.label}
                {c.count != null && <span className="ml-1.5 font-mono text-[11px] text-haze">{c.count}</span>}
              </button>
            );
          })}
        </nav>
      )}

      {files.isPending ? (
        <GridSkeleton />
      ) : files.isError ? (
        <ErrorState error={files.error} onRetry={() => files.refetch()} />
      ) : noProviders && !items.length ? (
        <EmptyState icon={Plugs} title="Choose where files live" action={<Button to="/app/settings" variant="primary">Set up storage</Button>}>
          Connect Google Drive or Dropbox, or enable local storage, and your library appears here.
        </EmptyState>
      ) : !items.length && tag ? (
        <EmptyState icon={CloudArrowUp} title={`Nothing tagged “${tag}”`} action={<Button onClick={() => setParams({})}>Show everything</Button>} />
      ) : !items.length ? (
        <EmptyState icon={CloudArrowUp} title="Your library is empty" action={<Button variant="primary" onClick={() => setPanelOpen(true)}>Upload images</Button>}>
          Drop photos, screenshots or receipts. They&apos;re deduplicated, indexed for natural-language search, and receipts are totalled automatically.
        </EmptyState>
      ) : (
        <>
          <ImageGrid items={items} onOpen={setOpen} />
          <div ref={sentinel} className="h-px" />
          {isFetchingNextPage && <GridSkeleton count={4} />}
        </>
      )}

      <Lightbox item={open} onClose={() => setOpen(null)} />
    </>
  );
}
