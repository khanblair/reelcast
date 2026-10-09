import type { ComponentProps, ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** Compact header cell: sentence case, 40px tall. */
export function Th({ className, ...props }: ComponentProps<typeof TableHead>) {
  return <TableHead className={cn("h-10 whitespace-nowrap px-4 text-xs", className)} {...props} />;
}

/** Compact body cell: rows land between 40 and 52px depending on whether a second line is shown. */
export function Td({ className, ...props }: ComponentProps<typeof TableCell>) {
  return <TableCell className={cn("h-11 px-4 py-2", className)} {...props} />;
}

/** Right-aligned numeric column classes. */
export const NUM = "text-right tabular-nums";

/** Wrapper around a table card: horizontal scroll stays inside the card, never the page. */
export function TableCard({ children, stale, className }: { children: ReactNode; stale?: boolean; className?: string }) {
  return (
    <div
      className={cn("overflow-hidden rounded-lg border border-border bg-card transition-opacity duration-150 motion-reduce:transition-none", stale && "opacity-60", className)}
      aria-busy={stale ? true : undefined}
    >
      {children}
    </div>
  );
}

export type SkeletonCell = { w: string; twoLine?: boolean; right?: boolean };

/** Placeholder rows with the same cell structure as the real rows. */
export function SkeletonRows({ rows, cells }: { rows: number; cells: SkeletonCell[] }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <TableRow key={r} className="hover:bg-transparent">
          {cells.map((c, i) => (
            <Td key={i} className={c.right ? "text-right" : undefined}>
              <div className={cn("space-y-1.5", c.right && "flex flex-col items-end")}>
                <Skeleton className={cn("h-4", c.w)} />
                {c.twoLine ? <Skeleton className="h-3 w-16" /> : null}
              </div>
            </Td>
          ))}
        </TableRow>
      ))}
    </>
  );
}
