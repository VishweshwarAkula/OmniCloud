import { useState } from "react";
import { formatMoney, formatMonth } from "../../lib/format";

// #10a876: brand mint stepped into the validated dark-mode lightness band (dataviz check).
const BAR = "#10a876";
const BAR_HOVER = "#00ff88";

function niceMax(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= v);
}

/** Single-series monthly spend: one hue, thin bars, per-bar hover/focus tooltip. */
export function MonthlyBars({ data, currency }) {
  const [active, setActive] = useState(null);
  const series = data.slice(-12);
  const max = niceMax(Math.max(...series.map((d) => d.total), 0));
  const ticks = [0, max / 2, max];

  return (
    <figure className="relative">
      <div className="relative flex h-56 gap-3 pl-12">
        {/* recessive grid + y labels */}
        {ticks.map((t) => (
          <div key={t} className="pointer-events-none absolute inset-x-0 flex items-center gap-3" style={{ bottom: `${(t / max) * 100}%` }}>
            <span className="w-9 text-right font-mono text-[10px] text-haze">{formatMoney(t, null).replace(/\.00$/, "")}</span>
            <span className={`h-px flex-1 ${t === 0 ? "bg-white/15" : "bg-white/[0.05]"}`} />
          </div>
        ))}
        {series.map((d, i) => {
          const h = (d.total / max) * 100;
          const isActive = active === i;
          return (
            <button
              key={d.month}
              type="button"
              className="group relative flex flex-1 items-end justify-center outline-none"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              aria-label={`${formatMonth(d.month)} ${d.month.slice(0, 4)}: ${formatMoney(d.total, currency)}`}
            >
              <span
                className="block w-full max-w-6 rounded-t-[4px] transition-[background-color] duration-300"
                style={{ height: `max(${h}%, 2px)`, background: isActive ? BAR_HOVER : BAR }}
              />
              {isActive && (
                <span role="tooltip" className="glass absolute z-10 whitespace-nowrap rounded-xl px-3 py-2 text-left text-xs" style={{ bottom: `calc(${h}% + 8px)` }}>
                  <span className="block text-mist">{formatMonth(d.month)} {d.month.slice(0, 4)}</span>
                  <span className="font-mono text-fog">{formatMoney(d.total, currency)}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex gap-3 pl-12">
        {series.map((d) => (
          <span key={d.month} className="flex-1 text-center font-mono text-[10px] text-haze">
            {formatMonth(d.month)}
          </span>
        ))}
      </div>
      <figcaption className="sr-only">Monthly receipt totals for the last {series.length} months. The full list is in the table below.</figcaption>
    </figure>
  );
}
