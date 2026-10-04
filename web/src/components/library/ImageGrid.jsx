import { ImageBroken, Sparkle } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { easeSpring } from "../../lib/motion";
import { ProviderBadge } from "../ui/Brand";
import { Skeleton } from "../ui/Feedback";

function Tile({ item, index, onOpen }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const reduce = useReducedMotion();
  const indexing = item.status === "indexing";
  // Known dimensions reserve the right box before the image arrives (no layout shift).
  const ratio = item.width && item.height ? `${item.width} / ${item.height}` : undefined;

  return (
    <motion.li
      className="mb-3 break-inside-avoid sm:mb-4"
      initial={reduce ? false : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: Math.min(index % 30, 12) * 0.035, ease: easeSpring }}
    >
      <button
        onClick={() => onOpen(item)}
        className="group relative block w-full overflow-hidden rounded-[1.25rem] bg-white/[0.03] p-1 ring-1 ring-white/[0.07] transition duration-700 ease-[var(--ease-spring)] hover:ring-white/20"
        aria-label={`Open ${item.name || "image"}`}
      >
        <div className="relative overflow-hidden rounded-[1rem]" style={{ aspectRatio: ratio }}>
          {!loaded && !failed && <Skeleton className={`w-full rounded-none ${ratio ? "absolute inset-0 h-full" : "aspect-[4/5]"}`} />}
          {failed ? (
            <div className="flex aspect-square w-full items-center justify-center bg-white/[0.02]">
              <ImageBroken size={28} weight="thin" className="text-haze" />
            </div>
          ) : (
            <motion.img
              layoutId={`media-${item.id}`}
              src={item.thumbUrl}
              alt={item.name || ""}
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={`w-full object-cover transition duration-[1.2s] ease-[var(--ease-spring)] group-hover:scale-[1.04] ${ratio ? "h-full" : ""} ${loaded ? "opacity-100" : "absolute inset-0 opacity-0"}`}
            />
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/70 via-transparent opacity-0 transition duration-500 group-hover:opacity-100" />
          <div className="absolute inset-x-2 bottom-2 flex items-center justify-between opacity-0 transition duration-500 ease-[var(--ease-spring)] group-hover:opacity-100 group-focus-visible:opacity-100">
            <ProviderBadge provider={item.provider} />
            {item.score != null && <span className="rounded-full bg-ink/85 px-2 py-1 font-mono text-[10px] text-mint ring-1 ring-mint/30">{Math.round(item.score * 100)}%</span>}
          </div>
          {indexing && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-ink/85 px-2 py-1 text-[10px] text-mint ring-1 ring-mint/30">
              <Sparkle size={10} weight="fill" className="animate-pulse" /> Indexing
            </span>
          )}
        </div>
      </button>
    </motion.li>
  );
}

/** Masonry grid via CSS columns: natural aspect ratios, no layout JS. */
export function ImageGrid({ items, onOpen }) {
  return (
    <ul className="columns-2 gap-3 sm:gap-4 md:columns-3 xl:columns-4 2xl:columns-5">
      {items.map((item, i) => (
        <Tile key={item.id} item={item} index={i} onOpen={onOpen} />
      ))}
    </ul>
  );
}

export function GridSkeleton({ count = 12 }) {
  const heights = ["aspect-[4/5]", "aspect-square", "aspect-[3/4]", "aspect-[4/3]", "aspect-[2/3]"];
  return (
    <div className="columns-2 gap-3 sm:gap-4 md:columns-3 xl:columns-4 2xl:columns-5" aria-busy="true" aria-label="Loading images">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={`mb-3 w-full sm:mb-4 ${heights[i % heights.length]}`} />
      ))}
    </div>
  );
}
