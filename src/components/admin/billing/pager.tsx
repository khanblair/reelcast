import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * "Showing a-b of total" with previous/next. Pass `total` as undefined while the first page loads
 * and it renders a placeholder with the same height. The buttons only appear when there is more than one page.
 */
export function Pager({
  total,
  offset,
  pageSize,
  onOffsetChange,
  className,
}: {
  total: number | undefined;
  offset: number;
  pageSize: number;
  onOffsetChange: (offset: number) => void;
  className?: string;
}) {
  const hasPages = total !== undefined && total > pageSize;
  const from = total === undefined || total === 0 ? 0 : offset + 1;
  const to = total === undefined ? 0 : Math.min(offset + pageSize, total);

  return (
    <nav aria-label="Pagination" className={cn("flex min-h-14 items-center justify-between gap-3 px-4 py-3", className)}>
      {total === undefined ? (
        <Skeleton className="h-4 w-36" />
      ) : (
        <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {total === 0 ? "No results" : `Showing ${from}–${to} of ${total}`}
        </p>
      )}
      {hasPages ? (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={offset <= 0} onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}>
            <ChevronLeft aria-hidden className="size-4" />
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={offset + pageSize >= total} onClick={() => onOffsetChange(offset + pageSize)}>
            Next
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
