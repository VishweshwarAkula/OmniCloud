import { WarningCircle } from "@phosphor-icons/react";
import { Button } from "./Button";

export function Skeleton({ className = "" }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl bg-white/[0.04] ${className}`} aria-hidden="true">
      <div className="absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
      {Icon && (
        <div className="bezel mb-8">
          <div className="bezel-core flex h-20 w-20 items-center justify-center">
            <Icon size={32} weight="thin" className="text-mint" />
          </div>
        </div>
      )}
      <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
      {children && <p className="mt-3 text-pretty text-mist">{children}</p>}
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
      <WarningCircle size={36} weight="thin" className="text-bad" />
      <h3 className="mt-5 text-lg font-semibold">Something didn&apos;t load</h3>
      <p className="mt-2 text-sm text-mist">{error?.message || "Please try again."}</p>
      {onRetry && (
        <Button className="mt-6" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Meter({ value, label, sub }) {
  const pct = Math.max(0, Math.min(1, value || 0));
  return (
    <div>
      {(label || sub) && (
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <span className="text-fog">{label}</span>
          <span className="font-mono text-xs text-mist">{sub}</span>
        </div>
      )}
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label={label}>
        <div
          className="h-full origin-left rounded-full bg-gradient-to-r from-mint to-aqua transition-transform duration-1000 ease-[var(--ease-spring)]"
          style={{ transform: `scaleX(${pct})` }}
        />
      </div>
    </div>
  );
}
