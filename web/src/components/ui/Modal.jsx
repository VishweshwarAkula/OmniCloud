import { X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { easeSpring } from "../../lib/motion";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

/** Accessible dialog: focus trap, Esc to close, focus restored on close, scroll lock. */
export function Modal({ open, onClose, title, children, size = "md", bare = false }) {
  const panel = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => panel.current?.querySelector(FOCUSABLE)?.focus(), 30);

    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !panel.current) return;
      const nodes = [...panel.current.querySelectorAll(FOCUSABLE)];
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onClose]);

  const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-6xl" };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex items-end justify-center p-3 sm:items-center sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: easeSpring }}
        >
          <div className="absolute inset-0 bg-ink/70 backdrop-blur-xl" onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            className={`relative w-full ${widths[size]} ${bare ? "" : "bezel"}`}
            initial={{ opacity: 0, y: 40, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ duration: 0.55, ease: easeSpring }}
          >
            {bare ? (
              children
            ) : (
              <div className="bezel-core max-h-[85dvh] overflow-y-auto p-6 sm:p-8">
                <div className="mb-6 flex items-start justify-between gap-4">
                  {title && (
                    <h2 id={titleId} className="text-xl font-semibold tracking-tight">
                      {title}
                    </h2>
                  )}
                  <button onClick={onClose} className="-mr-2 -mt-1 rounded-full p-2 text-mist transition hover:bg-white/5 hover:text-fog" aria-label="Close">
                    <X size={18} weight="light" />
                  </button>
                </div>
                {children}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
