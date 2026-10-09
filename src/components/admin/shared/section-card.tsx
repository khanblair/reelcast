import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A bordered panel with a compact header row (title, optional count/description, optional action).
 * Same look as the sections on the billing overview. Tables inside it should bring their own horizontal scroll.
 */
export function SectionCard({
  title,
  meta,
  description,
  action,
  children,
  className,
}: {
  title: string;
  /** Muted text after the title, e.g. a count. */
  meta?: ReactNode;
  /** One muted line under the header row. */
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}
    >
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-2">
        <div className="min-w-0">
          <h2 id={id} className="text-sm font-semibold">
            {title}
            {meta !== undefined && meta !== null && meta !== false ? (
              <span className="ml-2 font-normal tabular-nums text-muted-foreground">{meta}</span>
            ) : null}
          </h2>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
