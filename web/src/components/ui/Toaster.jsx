import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { useToast } from "../../hooks/useToast";
import { easeSpring } from "../../lib/motion";

const tones = {
  success: { Icon: CheckCircle, cls: "text-ok" },
  error: { Icon: WarningCircle, cls: "text-bad" },
  info: { Icon: Info, cls: "text-aqua" },
};

export function Toaster() {
  const { toasts, dismiss } = useToast();
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-24 z-50 flex flex-col items-center gap-2 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:items-end" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const { Icon, cls } = tones[t.tone] || tones.info;
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, transition: { duration: 0.25 } }}
              transition={{ duration: 0.5, ease: easeSpring }}
              className="glass pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl p-4 shadow-[0_20px_60px_-20px_rgb(0_0_0/0.8)]"
              role={t.tone === "error" ? "alert" : "status"}
            >
              <Icon size={20} weight="light" className={`mt-0.5 shrink-0 ${cls}`} />
              <div className="min-w-0 flex-1 text-sm">
                {t.title && <p className="font-medium">{t.title}</p>}
                <p className="text-mist">{t.message}</p>
              </div>
              <button onClick={() => dismiss(t.id)} className="rounded-full p-1 text-haze transition hover:text-fog" aria-label="Dismiss">
                <X size={14} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
