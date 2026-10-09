import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Pulse that stops for users who ask for reduced motion. */
function Bar({ className }: { className?: string }) {
  return <Skeleton className={cn("motion-reduce:animate-none", className)} />;
}

/**
 * Loading placeholder for a table: an optional header row plus `rows` rows at the real 44px row height, so the page
 * does not jump when data arrives. Meant to sit inside the table's card.
 */
export function TableSkeleton({
  rows = 6,
  cols = 4,
  header = true,
}: {
  rows?: number;
  cols?: number;
  /** Include a header row. Turn off when the real table header is already on screen. */
  header?: boolean;
}) {
  return (
    <div role="status" aria-busy="true" className="divide-y">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows + (header ? 1 : 0) }, (_, i) => {
        const isHeader = header && i === 0;
        return (
          <div
            key={i}
            className={cn("grid items-center gap-4 px-4", isHeader ? "h-10" : "h-11")}
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: cols }, (_, c) => (
              <Bar key={c} className={cn("h-3.5", isHeader ? "w-16" : c === 0 ? "w-3/4" : "w-1/2")} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Loading placeholder for a card or panel of stacked lines. */
export function PanelSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cn("space-y-3 rounded-lg border p-5", className)}>
      <span className="sr-only">Loading…</span>
      <Bar className="h-4 w-40" />
      {Array.from({ length: lines }, (_, i) => (
        <Bar key={i} className={cn("h-3.5", i % 2 === 0 ? "w-full" : "w-2/3")} />
      ))}
    </div>
  );
}

export { Bar as SkeletonBar };
