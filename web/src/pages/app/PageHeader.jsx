import { Reveal } from "../../components/ui/Reveal";

export function PageHeader({ eyebrow, title, children, actions }) {
  return (
    <Reveal className="mb-10 flex flex-col gap-6 sm:mb-14 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">{title}</h1>
        {children && <p className="mt-3 max-w-xl text-pretty text-mist">{children}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </Reveal>
  );
}
