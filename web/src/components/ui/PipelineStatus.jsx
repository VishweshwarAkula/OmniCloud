import { CloudArrowUp, Cpu, Database, UserFocus } from "@phosphor-icons/react";
import { usePipeline } from "../../hooks/queries";
import { Bezel } from "./Bezel";

const STAGES = [
  { key: "upload", label: "Upload", Icon: CloudArrowUp },
  { key: "embed", label: "Embed", Icon: Cpu },
  { key: "faces", label: "Faces", Icon: UserFocus },
  { key: "finalize", label: "Finalize", Icon: Database },
];

function Replicas({ name, s, now }) {
  if (!s) return null;
  const stale = now - s.at > 30_000;
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl bg-white/[0.03] px-4 py-3 ring-1 ring-white/[0.06]">
      <div>
        <p className="text-sm">{name}</p>
        <p className="text-xs text-haze">
          {s.min}–{s.max} replicas{stale && " · autoscaler idle"}
        </p>
      </div>
      <div className="flex items-center gap-1" aria-label={`${s.current} of ${s.max} replicas running`}>
        {Array.from({ length: s.max }, (_, i) => (
          <span key={i} className={`h-5 w-2 rounded-full transition-colors duration-500 ${i < s.current ? "bg-mint" : i < s.desired ? "bg-mint/30" : "bg-white/[0.07]"}`} />
        ))}
        <span className="ml-2 font-mono text-xs text-mist">{s.current}</span>
      </div>
    </div>
  );
}

/** Live view of the ingest pipeline: queued jobs per stage and autoscaled replicas. */
export function PipelineStatus() {
  const { data, isError, dataUpdatedAt } = usePipeline();
  return (
    <Bezel coreClassName="p-6">
      <div className="mb-5 flex items-center justify-between">
        <h3 className="font-medium">Pipeline</h3>
        <span className={`inline-flex items-center gap-1.5 text-xs ${isError ? "text-bad" : "text-mist"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${isError ? "bg-bad" : "animate-pulse bg-mint"}`} />
          {isError ? "unavailable" : "live"}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STAGES.map(({ key, label, Icon }) => (
          <div key={key} className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/[0.06]">
            <dt className="flex items-center gap-2 text-xs text-haze">
              <Icon size={14} weight="light" /> {label}
            </dt>
            <dd className="mt-2 font-mono text-2xl">{data?.backlog?.[key] ?? "–"}</dd>
          </div>
        ))}
      </dl>
      {data?.scaling && Object.keys(data.scaling).length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Replicas name="Workers" s={data.scaling.worker} now={dataUpdatedAt} />
          <Replicas name="ML replicas" s={data.scaling.ml} now={dataUpdatedAt} />
        </div>
      ) : (
        <p className="mt-4 text-xs text-haze">Autoscaler not running. Enable the <code className="font-mono">autoscale</code> compose profile to scale workers with queue depth.</p>
      )}
    </Bezel>
  );
}
