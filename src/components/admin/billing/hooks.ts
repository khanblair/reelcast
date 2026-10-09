"use client";

import { useEffect, useState } from "react";

/** Debounced copy of a value, so typing does not fire a request per keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * Keeps showing the last loaded result while the next one loads, so changing a page or filter
 * dims the table instead of collapsing it back to a skeleton. `stale` is true while that happens.
 */
export function useKeepPrevious<T>(value: T | undefined): { data: T | undefined; stale: boolean } {
  const [last, setLast] = useState<T | undefined>(value);
  if (value !== undefined && value !== last) setLast(value);
  return { data: value ?? last, stale: value === undefined && last !== undefined };
}

/** Offset of the last non-empty page. Used to step back when the current page has emptied out. */
export const lastPageOffset = (total: number, pageSize: number) => Math.max(0, Math.floor((total - 1) / pageSize) * pageSize);
