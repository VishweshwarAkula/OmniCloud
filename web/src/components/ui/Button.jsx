import { CircleNotch } from "@phosphor-icons/react";
import { Link } from "react-router";

const base =
  "group relative inline-flex select-none items-center justify-center gap-3 rounded-full font-medium transition-all duration-500 ease-[var(--ease-spring)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";

const variants = {
  primary: "bg-gradient-to-r from-mint to-aqua text-ink shadow-[0_10px_40px_-12px_rgb(0_255_136/0.55)] hover:shadow-[0_14px_50px_-10px_rgb(0_229_255/0.6)]",
  solid: "bg-fog text-ink hover:bg-white",
  ghost: "bg-white/[0.04] text-fog ring-1 ring-white/10 hover:bg-white/[0.08] hover:ring-white/20",
  danger: "bg-bad/10 text-bad ring-1 ring-bad/30 hover:bg-bad/15",
  quiet: "text-mist hover:text-fog hover:bg-white/[0.05]",
};

const sizes = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-14 pl-7 pr-2 text-base",
  icon: "h-10 w-10",
};

/** Pill button. A trailing `icon` sits in its own circular "island" (button-in-button). */
export function Button({ variant = "ghost", size = "md", icon: Icon, leading: Leading, loading, to, href, className = "", children, ...props }) {
  const island = Icon && size === "lg";
  const cls = `${base} ${variants[variant]} ${sizes[size]} ${island ? "" : Icon ? "pr-4" : ""} ${className}`;
  const content = (
    <>
      {loading ? <CircleNotch className="animate-spin" size={18} weight="bold" /> : Leading && <Leading size={18} weight="light" />}
      {children}
      {Icon && (
        <span
          className={
            island
              ? `flex h-10 w-10 items-center justify-center rounded-full transition-transform duration-500 ease-[var(--ease-spring)] group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105 ${variant === "primary" || variant === "solid" ? "bg-ink/10" : "bg-white/10"}`
              : "transition-transform duration-500 ease-[var(--ease-spring)] group-hover:translate-x-0.5"
          }
        >
          <Icon size={island ? 18 : 16} weight={island ? "regular" : "light"} />
        </span>
      )}
    </>
  );

  if (to) return <Link to={to} className={cls} {...props}>{content}</Link>;
  if (href) return <a href={href} className={cls} {...props}>{content}</a>;
  return (
    <button type="button" className={cls} disabled={loading || props.disabled} {...props}>
      {content}
    </button>
  );
}
