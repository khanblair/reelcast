/**
 * Dev-only: run the job tick in-process every few seconds so `next dev` is the ONLY process
 * you need (no separate worker, no cron). In production the tick is driven by pg_cron.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "development") return;

  const g = globalThis as { __reelcastDevTick?: ReturnType<typeof setInterval> };
  if (g.__reelcastDevTick) return; // survive HMR without stacking intervals

  const { runTick } = await import("@/server/jobs/tick");
  let running = false;
  g.__reelcastDevTick = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runTick({ budgetMs: 25_000 });
      if (r.jobsRun || r.tasksRun || r.sweepsRun.length || r.errors.length) console.log("[dev tick]", JSON.stringify(r));
    } catch (e) {
      console.error("[dev tick] failed", e);
    } finally {
      running = false;
    }
  }, 5_000);
  console.log("[dev tick] job runner started (every 5s)");
}
