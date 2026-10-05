import { CloudArrowUp, GearSix, ImagesSquare, MagnifyingGlass, UsersThree } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { useProviders, useStorage } from "../../hooks/queries";
import { useUploads } from "../../hooks/useUploads";
import { formatBytes } from "../../lib/format";
import { CommandPalette, useCommandPalette } from "../search/CommandPalette";
import { Logo } from "../ui/Brand";
import { Meter } from "../ui/Feedback";
import { filesFromDrop } from "../../lib/folderFiles";
import { DropOverlay, UploadPanel } from "../upload/UploadPanel";
import { Backdrop } from "./Backdrop";

const nav = [
  { to: "/app", label: "Library", Icon: ImagesSquare, end: true },
  { to: "/app/search", label: "Search", Icon: MagnifyingGlass },
  { to: "/app/people", label: "People", Icon: UsersThree },
  { to: "/app/settings", label: "Settings", Icon: GearSix },
];

function Avatar({ user, size = 32 }) {
  return user?.avatar ? (
    <img src={user.avatar} alt="" width={size} height={size} referrerPolicy="no-referrer" className="rounded-full ring-1 ring-white/10" />
  ) : (
    <span style={{ width: size, height: size }} className="flex items-center justify-center rounded-full bg-gradient-to-br from-mint/30 to-aqua/30 text-xs font-semibold">
      {user?.name?.[0]?.toUpperCase()}
    </span>
  );
}

// Window-level drag & drop so files and whole folders can be dropped anywhere in the app.
function useWindowDrop(onFiles) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    const enter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const over = (e) => hasFiles(e) && e.preventDefault();
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    };
    const drop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      filesFromDrop(e.dataTransfer).then(onFiles);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragleave", leave);
    };
  }, [onFiles]);
  return dragging;
}

export function AppShell() {
  const { user } = useAuth();
  const { add, setPanelOpen, items, provider, setProvider } = useUploads();
  const { data: providers } = useProviders();
  const anyConnected = providers?.some((p) => p.connected);
  const { data: storage } = useStorage(Boolean(anyConnected));
  const [paletteOpen, setPaletteOpen] = useCommandPalette();
  const dragging = useWindowDrop(add);
  const location = useLocation();
  const activeUploads = items.filter((i) => !["done", "duplicate", "error", "cancelled"].includes(i.status)).length;

  // Default the upload target to a provider that is actually connected.
  useEffect(() => {
    if (!providers) return;
    const connected = providers.filter((p) => p.connected).map((p) => p.key);
    if (connected.length && !connected.includes(provider)) setProvider(connected[0]);
  }, [providers, provider, setProvider]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const used = storage?.overall?.used ?? 0;
  const total = storage?.overall?.total ?? 0;

  return (
    <div className="grain relative min-h-[100dvh]">
      <Backdrop intensity={0.55} />

      {/* Desktop sidebar */}
      <aside className="glass fixed inset-y-3 left-3 z-20 hidden w-64 flex-col rounded-[1.75rem] p-4 lg:flex">
        <div className="px-2 pb-6 pt-2">
          <Logo />
        </div>
        <button
          onClick={() => setPaletteOpen(true)}
          className="mb-4 flex items-center gap-3 rounded-full bg-white/[0.04] px-4 py-2.5 text-sm text-haze ring-1 ring-white/10 transition duration-500 ease-[var(--ease-spring)] hover:text-mist hover:ring-white/20"
        >
          <MagnifyingGlass size={16} weight="light" />
          Search
          <kbd className="ml-auto font-mono text-[10px]">⌘K</kbd>
        </button>
        <nav aria-label="App" className="space-y-1">
          {nav.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-full px-4 py-2.5 text-sm transition duration-500 ease-[var(--ease-spring)] ${
                  isActive ? "bg-white/[0.07] text-fog ring-1 ring-white/10" : "text-mist hover:bg-white/[0.04] hover:text-fog"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={18} weight={isActive ? "regular" : "light"} className={isActive ? "text-mint" : ""} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <button
          onClick={() => setPanelOpen(true)}
          className="group mt-6 flex items-center justify-between rounded-full bg-gradient-to-r from-mint to-aqua py-2 pl-5 pr-2 text-sm font-medium text-ink transition duration-500 ease-[var(--ease-spring)] active:scale-[0.98]"
        >
          Upload
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink/10 transition duration-500 ease-[var(--ease-spring)] group-hover:-translate-y-px group-hover:scale-105">
            {activeUploads ? <span className="font-mono text-xs">{activeUploads}</span> : <CloudArrowUp size={16} />}
          </span>
        </button>

        <div className="mt-auto space-y-4">
          {total > 0 && (
            <div className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/[0.06]">
              <Meter value={used / total} label="Storage" sub={`${formatBytes(used)} / ${formatBytes(total)}`} />
            </div>
          )}
          <div className="flex items-center gap-3 rounded-full bg-white/[0.03] p-1.5 pr-2 ring-1 ring-white/[0.06]">
            <Avatar user={user} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{user?.name}</p>
              <p className="truncate text-[11px] text-haze">{user?.email}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="glass fixed inset-x-3 top-3 z-20 flex items-center justify-between rounded-full py-1.5 pl-4 pr-1.5 lg:hidden">
        <Logo className="text-sm" />
        <div className="flex items-center gap-1">
          <button onClick={() => setPaletteOpen(true)} className="rounded-full p-2.5 text-mist" aria-label="Search">
            <MagnifyingGlass size={18} weight="light" />
          </button>
          <NavLink to="/app/settings" aria-label="Settings">
            <Avatar user={user} size={34} />
          </NavLink>
        </div>
      </header>

      {/* Mobile bottom tabs */}
      <nav aria-label="App" className="glass fixed inset-x-3 bottom-3 z-20 flex items-center justify-around rounded-full p-1.5 lg:hidden">
        {nav.slice(0, 3).map(({ to, label, Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `flex flex-col items-center gap-0.5 rounded-full px-2.5 py-1.5 text-[10px] sm:px-4 ${isActive ? "text-mint" : "text-mist"}`}>
            <Icon size={20} weight="light" />
            {label}
          </NavLink>
        ))}
        <button
          onClick={() => setPanelOpen(true)}
          className="relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-r from-mint to-aqua text-ink active:scale-95"
          aria-label="Upload"
        >
          <CloudArrowUp size={22} />
          {activeUploads > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink font-mono text-[10px] text-mint ring-1 ring-mint/40">{activeUploads}</span>}
        </button>
        {nav.slice(3).map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `flex flex-col items-center gap-0.5 rounded-full px-2.5 py-1.5 text-[10px] sm:px-4 ${isActive ? "text-mint" : "text-mist"}`}>
            <Icon size={20} weight="light" />
            {label}
          </NavLink>
        ))}
      </nav>

      <main className="px-4 pb-32 pt-24 sm:px-6 lg:pb-16 lg:pl-[18.5rem] lg:pr-8 lg:pt-10">
        <Outlet context={{ openPalette: () => setPaletteOpen(true) }} />
      </main>

      <UploadPanel />
      <DropOverlay visible={dragging} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
