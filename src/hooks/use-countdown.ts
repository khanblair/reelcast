"use client";

import { useState, useEffect } from "react";

function computeRemaining(targetMs: number | undefined): number {
  return targetMs ? Math.max(0, targetMs - Date.now()) : 0;
}

export function useCountdown(targetMs: number | undefined): number {
  const [remaining, setRemaining] = useState(() => computeRemaining(targetMs));
  const [prevTarget, setPrevTarget] = useState(targetMs);

  if (targetMs !== prevTarget) {
    setPrevTarget(targetMs);
    setRemaining(computeRemaining(targetMs));
  }

  useEffect(() => {
    if (!targetMs) return;
    const id = setInterval(() => setRemaining(computeRemaining(targetMs)), 1000);
    return () => clearInterval(id);
  }, [targetMs]);

  return remaining;
}
