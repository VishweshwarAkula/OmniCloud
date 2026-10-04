import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router";
import { easeSpring } from "../../lib/motion";
import { Logo } from "../ui/Brand";
import { Backdrop } from "./Backdrop";
import { SignInButton } from "./SignInButton";

const links = [
  { href: "/#features", label: "Features" },
  { href: "/#pipeline", label: "How it works" },
  { href: "/#security", label: "Security" },
];

function AuthCta({ size = "sm" }) {
  return <SignInButton size={size} variant={size === "sm" ? "solid" : "primary"}>{size === "sm" ? "Sign in" : undefined}</SignInButton>;
}

export function MarketingLayout() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="grain relative min-h-[100dvh] overflow-x-clip">
      <Backdrop />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-fog focus:px-4 focus:py-2 focus:text-ink">
        Skip to content
      </a>

      {/* Floating island nav */}
      <header className="fixed inset-x-0 top-0 z-30 flex justify-center px-4 pt-4 sm:pt-6">
        <nav className="glass flex w-full max-w-3xl items-center justify-between gap-6 rounded-full py-2 pl-5 pr-2" aria-label="Main">
          <Link to="/" aria-label="OmniCloud home">
            <Logo className="text-[15px]" />
          </Link>
          <ul className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <li key={l.href}>
                <a href={l.href} className="rounded-full px-3.5 py-2 text-sm text-mist transition duration-500 ease-[var(--ease-spring)] hover:bg-white/5 hover:text-fog">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="hidden md:block">
            <AuthCta />
          </div>
          <button
            className="relative flex h-10 w-10 items-center justify-center rounded-full bg-white/5 md:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
          >
            <span className={`absolute h-px w-4 bg-fog transition-transform duration-500 ease-[var(--ease-spring)] ${open ? "rotate-45" : "-translate-y-[3px]"}`} />
            <span className={`absolute h-px w-4 bg-fog transition-transform duration-500 ease-[var(--ease-spring)] ${open ? "-rotate-45" : "translate-y-[3px]"}`} />
          </button>
        </nav>
      </header>

      <AnimatePresence>
        {open && (
          <motion.div
            id="mobile-menu"
            className="fixed inset-0 z-20 flex flex-col justify-center bg-ink/85 px-8 backdrop-blur-3xl md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: easeSpring }}
          >
            <ul className="space-y-2">
              {links.map((l, i) => (
                <li key={l.href} className="overflow-hidden">
                  <motion.a
                    href={l.href}
                    onClick={() => setOpen(false)}
                    className="block py-2 text-4xl font-medium tracking-tight"
                    initial={{ y: 48, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.08 + i * 0.05, duration: 0.7, ease: easeSpring }}
                  >
                    {l.label}
                  </motion.a>
                </li>
              ))}
            </ul>
            <motion.div className="mt-10" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.7, ease: easeSpring }}>
              <AuthCta size="lg" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <main id="main">
        <Outlet />
      </main>

      <footer className="border-t border-white/[0.06] px-4">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 py-14 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Logo />
            <p className="mt-3 max-w-xs text-sm text-haze">Every cloud, one calm surface.</p>
          </div>
          <div className="flex items-center gap-6 text-sm text-mist">
            <a href="/#security" className="transition hover:text-fog">Security</a>
            <a href="/#features" className="transition hover:text-fog">Features</a>
          </div>
        </div>
        <div className="mx-auto max-w-6xl pb-10 text-xs text-haze">© {new Date().getFullYear()} OmniCloud</div>
      </footer>
    </div>
  );
}
