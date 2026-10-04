import { DropboxLogo, GoogleDriveLogo, HardDrives } from "@phosphor-icons/react";
import { useId } from "react";

export function Logo({ className = "" }) {
  // Unique per instance: a gradient defined inside a display:none copy breaks url(#id) refs.
  const gid = useId();
  return (
    <span className={`inline-flex items-center gap-2.5 font-semibold tracking-tight ${className}`}>
      <svg viewBox="0 0 64 64" className="h-7 w-7" aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#00ff88" />
            <stop offset="1" stopColor="#00e5ff" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="18" fill="#0b0c0c" stroke="rgb(255 255 255 / 0.1)" />
        <path
          d="M14 32c0-5 4-9 8.5-9 7.5 0 11.5 18 19 18 4.5 0 8.5-4 8.5-9s-4-9-8.5-9c-7.5 0-11.5 18-19 18C18 41 14 37 14 32z"
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth="4.5"
          strokeLinecap="round"
        />
      </svg>
      OmniCloud
    </span>
  );
}

export const providerMeta = {
  gdrive: { label: "Google Drive", Icon: GoogleDriveLogo, tint: "text-[#4f9cff]" },
  dropbox: { label: "Dropbox", Icon: DropboxLogo, tint: "text-[#3d8bff]" },
  local: { label: "Local disk", Icon: HardDrives, tint: "text-mint" },
};

export function ProviderBadge({ provider, className = "" }) {
  const meta = providerMeta[provider];
  if (!meta) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-ink/85 px-2 py-1 text-[10px] font-medium text-fog ring-1 ring-white/10 ${className}`}>
      <meta.Icon size={12} weight="fill" className={meta.tint} />
      {meta.label}
    </span>
  );
}
