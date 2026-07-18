"use client";

import { useState, useEffect } from "react";

export function useCountdown(targetMs: number | undefined): number {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!targetMs) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(Math.max(0, targetMs - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetMs]);

  return remaining;
}
