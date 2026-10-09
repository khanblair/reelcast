import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Standard frame for every admin page: a title row (title, one-line description, actions) and the content.
 * The shell (sidebar and top bar) comes from the admin layout; pages never render their own navigation.
 *
 * Server- and client-safe (no hooks), so it can wrap either kind of page.
 */
export function AdminPage({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  /** Buttons/filters shown on the right of the title row (wraps under the title on small screens). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1400px] space-y-6", className)}>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">{title}</h1>
          {description ? <p className="max-w-prose text-sm text-muted-foreground text-pretty">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}
