"use client";

import { useState, useEffect } from "react";

// A periodically-refreshed timestamp for render logic that needs "now" (e.g.
// filtering items by a future scheduled time) without calling the impure
// Date.now() directly during render/useMemo.
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
