import { Brain, Cpu, Cloud, MagicWand, MapPin, UserFocus } from "@phosphor-icons/react";
import { useCapabilities } from "../../hooks/queries";
import { Bezel } from "./Bezel";

const FEATURES = [
  { key: "places", label: "Places", Icon: MapPin, api: "OpenStreetMap", local: "GeoNames, offline" },
  { key: "faces", label: "Faces", Icon: UserFocus, api: "—", local: "YuNet + SFace, on-device" },
  { key: "understand", label: "Query understanding", Icon: Brain, api: "Gemini", local: "Rules, on-device", llm: "Qwen3-0.6B + rules, on-device" },
  { key: "rerank", label: "Re-ranking", Icon: MagicWand, api: "Gemini vision", local: "SigLIP + MMR, on-device" },
];

/** Which AI features use an API right now and which run locally. */
export function Capabilities() {
  const { data, isError } = useCapabilities();
  return (
    <Bezel coreClassName="p-6">
      <div className="mb-5 flex items-center justify-between">
        <h3 className="font-medium">Intelligence</h3>
        {data?.model && <span className="font-mono text-[11px] text-haze">{data.model}</span>}
      </div>
      {isError || data?.unavailable ? (
        <p className="text-sm text-bad">The ML service isn&apos;t reachable right now.</p>
      ) : (
        <ul className="divide-y divide-white/[0.05]">
          {FEATURES.map(({ key, label, Icon, api, local, llm }) => {
            const mode = data?.[key];
            const isApi = mode === "api";
            return (
              <li key={key} className="flex items-center justify-between gap-4 py-3">
                <span className="flex items-center gap-3 text-sm">
                  <Icon size={18} weight="light" className="text-mint" /> {label}
                </span>
                <span className={`inline-flex items-center gap-1.5 text-xs ${mode ? "text-mist" : "text-haze"}`}>
                  {mode ? (isApi ? <Cloud size={13} /> : <Cpu size={13} />) : null}
                  {!data ? "…" : mode ? (isApi ? api : mode === "llm" ? llm : local) : "off"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 text-xs text-haze">Each API feature falls back to its on-device version automatically if the API fails.</p>
    </Bezel>
  );
}
