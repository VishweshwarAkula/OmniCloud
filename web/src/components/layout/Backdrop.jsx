/** Fixed ambient mesh glow. Lives outside the scroll flow so it never repaints on scroll. */
export function Backdrop({ intensity = 1 }) {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div
        className="absolute -left-[20%] -top-[30%] h-[70vmax] w-[70vmax] rounded-full blur-[120px]"
        style={{ background: "radial-gradient(circle, rgb(0 255 136 / 0.16), transparent 60%)", opacity: intensity }}
      />
      <div
        className="absolute -right-[25%] top-[10%] h-[60vmax] w-[60vmax] rounded-full blur-[140px]"
        style={{ background: "radial-gradient(circle, rgb(0 229 255 / 0.12), transparent 60%)", opacity: intensity }}
      />
      <div
        className="absolute inset-0 opacity-[0.25]"
        style={{
          backgroundImage: "linear-gradient(rgb(255 255 255 / 0.035) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / 0.035) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "radial-gradient(ellipse at 50% 0%, black 20%, transparent 70%)",
        }}
      />
    </div>
  );
}
