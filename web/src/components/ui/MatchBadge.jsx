// How well a search result matches, from a calibrated signal (per-image margin, or the re-ranker's
// own judgement) — not a percentage, which would only be relative to the other results.
const MATCH = {
  strong: { label: "Strong match", cls: "text-mint ring-mint/40" },
  good: { label: "Good match", cls: "text-aqua ring-aqua/35" },
  possible: { label: "Possible match", cls: "text-mist ring-white/15" },
  metadata: { label: "Date / place / tag match", cls: "text-mist ring-white/15" },
  keyword: { label: "Keyword match", cls: "text-mist ring-white/15" },
};

export function matchLabel(match) {
  return MATCH[match]?.label ?? null;
}

export function MatchBadge({ match, className = "" }) {
  const m = MATCH[match];
  if (!m) return null;
  return <span className={`rounded-full bg-ink/85 px-2 py-1 text-[10px] font-medium ring-1 ${m.cls} ${className}`}>{m.label}</span>;
}
