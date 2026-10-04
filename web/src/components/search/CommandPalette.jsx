import { ArrowRight, MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Modal } from "../ui/Modal";

const SUGGESTIONS = ["receipts from last month", "sunset at the beach", "my dog", "whiteboard notes", "food"];

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      const typing = /input|textarea|select/i.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [open, setOpen];
}

export function CommandPalette({ open, onClose }) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();

  const go = (query) => {
    const value = query.trim();
    if (!value) return;
    onClose();
    setQ("");
    navigate(`/app/search?q=${encodeURIComponent(value)}`);
  };

  return (
    <Modal open={open} onClose={onClose} size="md" bare>
      <div className="bezel">
        <div className="bezel-core overflow-hidden">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              go(q);
            }}
            className="flex items-center gap-3 border-b border-white/[0.06] px-5"
            role="search"
          >
            <MagnifyingGlass size={20} weight="light" className="text-mist" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Describe a photo… “receipts from March”"
              aria-label="Search your images"
              className="h-16 w-full bg-transparent text-lg outline-none placeholder:text-haze"
            />
            <kbd className="hidden rounded-md bg-white/5 px-2 py-1 font-mono text-[11px] text-haze ring-1 ring-white/10 sm:block">esc</kbd>
          </form>
          <div className="p-3">
            <p className="px-3 pb-2 pt-1 text-[11px] uppercase tracking-[0.18em] text-haze">Try</p>
            <ul>
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    onClick={() => go(s)}
                    className="group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-mist transition duration-300 hover:bg-white/[0.05] hover:text-fog"
                  >
                    {s}
                    <ArrowRight size={14} className="opacity-0 transition duration-300 group-hover:translate-x-0.5 group-hover:opacity-100" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Modal>
  );
}
