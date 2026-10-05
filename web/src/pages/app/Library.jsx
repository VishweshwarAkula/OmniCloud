import { CloudArrowUp, FolderSimple, Plugs, Trash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { GridSkeleton, ImageGrid } from "../../components/library/ImageGrid";
import { Lightbox } from "../../components/library/Lightbox";
import { Button } from "../../components/ui/Button";
import { EmptyState, ErrorState } from "../../components/ui/Feedback";
import { useDeleteFolder, useFiles, useFolders, usePeople, useProviders, useTags } from "../../hooks/queries";
import { useToast } from "../../hooks/useToast";
import { Modal } from "../../components/ui/Modal";
import { FaceThumb } from "../../components/ui/FaceThumb";
import { useUploads } from "../../hooks/useUploads";
import { PageHeader } from "./PageHeader";

function DeleteFolderDialog({ folder, count, open, onClose, onDeleted }) {
  const del = useDeleteFolder();
  const { toast } = useToast();
  const run = (fromCloud) =>
    del.mutate(
      { path: folder, fromCloud },
      {
        onSuccess: (r) => {
          toast(
            fromCloud
              ? `Deleted ${r.files} files from your cloud and OmniCloud.`
              : `Removed ${r.files} files from OmniCloud. They're still in your cloud.`,
            { tone: "success" }
          );
          onDeleted();
        },
        onError: (e) => toast(e.message, { tone: "error" }),
      }
    );
  return (
    <Modal open={open} onClose={() => !del.isPending && onClose()} title={`Delete “${folder}”?`} size="sm">
      <p className="text-sm text-mist">
        {count ?? "All"} files in this folder and its subfolders. Remove them from OmniCloud only, or delete them from your cloud too?
      </p>
      <p className="mt-2 text-xs text-haze">
        Deleting from the cloud also removes the folders that are left empty. Anything else you put in them stays.
      </p>
      <div className="mt-5 flex flex-col gap-2">
        <Button loading={del.isPending && !del.variables?.fromCloud} disabled={del.isPending} onClick={() => run(false)}>
          Remove from OmniCloud
        </Button>
        <Button variant="danger" loading={del.isPending && del.variables?.fromCloud} disabled={del.isPending} onClick={() => run(true)}>
          Delete from cloud too
        </Button>
        <Button variant="quiet" size="sm" disabled={del.isPending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

export default function Library() {
  const [params, setParams] = useSearchParams();
  const tag = params.get("tag") || undefined;
  const person = params.get("person") || undefined;
  const folder = params.get("folder") || undefined;
  const files = useFiles(tag, person, folder);
  const { data: people = [] } = usePeople(true);
  const personInfo = person ? people.find((p) => p.id === person) : null;
  const { data: tags = [] } = useTags();
  const { data: folders = [] } = useFolders();
  const { data: providers } = useProviders();
  const { setPanelOpen } = useUploads();
  const [open, setOpen] = useState(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
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
        Your photos and documents, newest first. Drop files anywhere on this page to add more.
        </PageHeader>

      {person && (
        <div className="mb-8 inline-flex items-center gap-3 rounded-full bg-white/[0.04] py-1.5 pl-1.5 pr-2 ring-1 ring-white/10">
          <FaceThumb cover={personInfo?.cover} size="32px" className="rounded-full" />
          <span className="text-sm">Photos of <span className="text-fog">{personInfo?.name || "this person"}</span></span>
          <button onClick={() => setParams({})} className="rounded-full p-1 text-haze hover:text-fog" aria-label="Clear person filter">✕</button>
        </div>
      )}

      {!person && (tags.length > 0 || folders.length > 0) && (
        <nav aria-label="Filter by folder or tag" className="-mx-4 mb-8 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {[
            { label: "All", filter: {} },
            ...folders.map((f) => ({ label: f.folder, count: f.count, filter: { folder: f.folder }, Icon: FolderSimple })),
            ...tags.map((t) => ({ label: t.tag, count: t.count, filter: { tag: t.tag } })),
          ].map((c) => {
            const active = (c.filter.folder ?? null) === (folder ?? null) && (c.filter.tag ?? null) === (tag ?? null);
            return (
              <button
                key={`${c.filter.folder ? "f" : "t"}:${c.label}`}
                onClick={() => setParams(c.filter)}
                aria-pressed={active}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm ring-1 transition duration-500 ease-[var(--ease-spring)] ${
                  active ? "bg-mint/10 text-fog ring-mint/40" : "text-mist ring-white/10 hover:bg-white/[0.04] hover:text-fog"
                }`}
              >
                {c.Icon && <c.Icon size={14} weight="fill" className="-ml-0.5 mr-1.5 inline align-[-2px] text-aqua" />}
                {c.label}
                {c.count != null && <span className="ml-1.5 font-mono text-[11px] text-haze">{c.count}</span>}
              </button>
            );
          })}
        </nav>
      )}

      {folder && (
        <div className="mb-8 flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm text-mist">
            <FolderSimple size={16} weight="fill" className="text-aqua" />
            OmniCloud/<span className="text-fog">{folder}</span>
          </span>
          <Button variant="quiet" size="sm" leading={Trash} onClick={() => setDeletingFolder(true)}>
            Delete folder
          </Button>
        </div>
      )}
      {folder && (
        <DeleteFolderDialog
          folder={folder}
          count={folders.find((f) => f.folder === folder)?.count}
          open={deletingFolder}
          onClose={() => setDeletingFolder(false)}
          onDeleted={() => {
            setDeletingFolder(false);
            setParams({});
          }}
        />
      )}

      {files.isPending ? (
        <GridSkeleton />
      ) : files.isError ? (
        <ErrorState error={files.error} onRetry={() => files.refetch()} />
      ) : noProviders && !items.length ? (
        <EmptyState icon={Plugs} title="Choose where files live" action={<Button to="/app/settings" variant="primary">Set up storage</Button>}>
          Connect Google Drive, Dropbox, Koofr or pCloud, and your library appears here.
        </EmptyState>
      ) : !items.length && (tag || folder) ? (
        <EmptyState icon={CloudArrowUp} title={tag ? `Nothing tagged “${tag}”` : `Nothing in “${folder}”`} action={<Button onClick={() => setParams({})}>Show everything</Button>} />
      ) : !items.length ? (
        <EmptyState icon={CloudArrowUp} title="Your library is empty" action={<Button variant="primary" onClick={() => setPanelOpen(true)}>Upload images</Button>}>
          Drop photos, screenshots or documents (PDF, DOCX, TXT, MD). They&apos;re deduplicated and indexed for natural-language search; photos are also grouped by people and places.
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
