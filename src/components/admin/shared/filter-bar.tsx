import type { ReactNode } from "react";

/**
 * Layout for a page's filters: chip groups on the left, search and "Clear filters" on the right.
 * Wraps on narrow screens. Pass `onClear` only while a filter is active.
 */
export function FilterBar({
  children,
  search,
  onClear,
}: {
  children: ReactNode;
  search?: ReactNode;
  onClear?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>
      {search || onClear ? (
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          {search}
          {onClear ? (
            <button
              type="button"
              onClick={onClear}
              className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
