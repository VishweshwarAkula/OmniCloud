import { Check, Eye, EyeSlash, GitMerge, PencilSimple, UsersThree, X } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/Button";
import { EmptyState, ErrorState, Skeleton } from "../../components/ui/Feedback";
import { FaceThumb } from "../../components/ui/FaceThumb";
import { RevealGroup, RevealItem } from "../../components/ui/Reveal";
import { useMergePeople, usePeople, useUpdatePerson } from "../../hooks/queries";
import { useToast } from "../../hooks/useToast";
import { PageHeader } from "./PageHeader";

function NameEditor({ person, onDone }) {
  const update = useUpdatePerson();
  const { toast } = useToast();
  const [name, setName] = useState(person.name ?? "");
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate(
          { id: person.id, name },
          { onSuccess: onDone, onError: (err) => toast(err.message, { tone: "error" }) }
        );
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Add a name"
        aria-label="Name"
        maxLength={60}
        className="w-full min-w-0 rounded-full bg-white/[0.06] px-3 py-1.5 text-sm outline-none ring-1 ring-white/10 focus:ring-aqua/60"
        onKeyDown={(e) => e.key === "Escape" && onDone()}
      />
      <button type="submit" className="rounded-full p-1.5 text-mint hover:bg-white/5" aria-label="Save name">
        <Check size={16} />
      </button>
    </form>
  );
}

function PersonCard({ person, selecting, selected, onToggle }) {
  const [editing, setEditing] = useState(false);
  const update = useUpdatePerson();
  const body = (
    <>
      <FaceThumb cover={person.cover} className="rounded-[1.25rem] transition duration-700 ease-[var(--ease-spring)] group-hover:scale-[1.02]" />
      {selecting && (
        <span className={`absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full ring-1 ${selected ? "bg-mint text-ink ring-mint" : "bg-ink/70 ring-white/30"}`}>
          {selected && <Check size={14} weight="bold" />}
        </span>
      )}
    </>
  );
  return (
    <div className="group">
      {selecting ? (
        <button onClick={() => onToggle(person.id)} className="relative block w-full" aria-pressed={selected} aria-label={`Select ${person.name || "unnamed person"}`}>
          {body}
        </button>
      ) : (
        <Link to={`/app?person=${person.id}`} className="relative block" aria-label={`Photos of ${person.name || "this person"}`}>
          {body}
        </Link>
      )}
      <div className="mt-3 flex min-h-9 items-center justify-between gap-2 px-1">
        {editing ? (
          <NameEditor person={person} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div className="min-w-0">
              <p className={`truncate text-sm ${person.name ? "" : "text-haze"}`}>{person.name || "Add a name"}</p>
              <p className="font-mono text-[11px] text-haze">{person.faceCount} photos</p>
            </div>
            {!selecting && (
              <div className="flex shrink-0 opacity-60 transition group-hover:opacity-100">
                <button onClick={() => setEditing(true)} className="rounded-full p-1.5 text-mist hover:bg-white/5 hover:text-fog" aria-label="Rename">
                  <PencilSimple size={15} weight="light" />
                </button>
                <button
                  onClick={() => update.mutate({ id: person.id, hidden: !person.hidden })}
                  className="rounded-full p-1.5 text-mist hover:bg-white/5 hover:text-fog"
                  aria-label={person.hidden ? "Show this person again" : "Hide this person"}
                >
                  {person.hidden ? <Eye size={15} weight="light" /> : <EyeSlash size={15} weight="light" />}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function People() {
  const [showAll, setShowAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const people = usePeople(showAll, showHidden);
  const merge = useMergePeople();
  const { toast } = useToast();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState([]);

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const doMerge = () => {
    const list = people.data.filter((p) => selected.includes(p.id));
    // Keep the named / biggest cluster as the survivor.
    const target = [...list].sort((a, b) => Number(Boolean(b.name)) - Number(Boolean(a.name)) || b.faceCount - a.faceCount)[0];
    merge.mutate(
      { target: target.id, sources: selected.filter((id) => id !== target.id) },
      {
        onSuccess: () => {
          toast(`Merged ${selected.length} into ${target.name || "one person"}.`, { tone: "success" });
          setSelected([]);
          setSelecting(false);
        },
        onError: (err) => toast(err.message, { tone: "error" }),
      }
    );
  };

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Faces, grouped for you"
        actions={
          people.data?.length > 1 &&
          (selecting ? (
            <>
              <Button variant="primary" leading={GitMerge} disabled={selected.length < 2} loading={merge.isPending} onClick={doMerge}>
                Merge {selected.length || ""}
              </Button>
              <Button variant="quiet" leading={X} onClick={() => (setSelecting(false), setSelected([]))}>Cancel</Button>
            </>
          ) : (
            <Button leading={GitMerge} onClick={() => setSelecting(true)}>Merge people</Button>
          ))
        }
      >
        Faces are detected and grouped on this machine; they never leave it. Name someone once and search for them by name, e.g.
        “Priya at the beach”.
      </PageHeader>

      {people.isPending ? (
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6">
          {Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="aspect-square" />)}
        </div>
      ) : people.isError ? (
        <ErrorState error={people.error} onRetry={() => people.refetch()} />
      ) : !people.data.length ? (
        <EmptyState icon={UsersThree} title="No people yet">
          People appear here once photos with faces are uploaded. Someone needs to show up in at least two photos to be listed.
        </EmptyState>
      ) : (
        <RevealGroup className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-6" step={0.03}>
          {people.data.map((p) => (
            <RevealItem key={p.id}>
              <PersonCard person={p} selecting={selecting} selected={selected.includes(p.id)} onToggle={toggle} />
            </RevealItem>
          ))}
        </RevealGroup>
      )}
      {people.data && (
        <div className="mt-10 text-center">
          <Button variant="quiet" size="sm" onClick={() => setShowAll((v) => !v)} disabled={showHidden}>
            {showAll ? "Hide people seen only once" : "Show people seen only once"}
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? "Back to people" : "Hidden people"}
          </Button>
        </div>
      )}
    </>
  );
}
