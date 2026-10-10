/**
 * Runs once when a server instance starts.
 *
 *  - production: check the environment (src/server/lib/env-check.ts) and log ONE warning naming any missing or
 *    unusable required variable. It only throws (refuses to start) when the operator set `ENV_STRICT=1`.
 *  - development, opt-in: run the job tick in-process every few seconds (`DEV_TICK=1` in `.env.local`).
 *    It is OFF by default because dev and production can share one database, and a local ticker would then
 *    claim and run real users' jobs. In production the tick is driven by pg_cron (`/api/cron/tick`).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "production") {
    const { runStartupEnvCheck } = await import("@/server/lib/env-check");
    runStartupEnvCheck(process.env);
    return;
  }
  if (process.env.NODE_ENV !== "development") return;

  const g = globalThis as { __reelcastDevTick?: ReturnType<typeof setInterval> | "off" };
  if (g.__reelcastDevTick) return; // survive HMR without stacking intervals (or repeating the "off" line)

  const { shouldRunDevTick, DEV_TICK_OFF_MESSAGE } = await import("@/server/jobs/dev-tick");
  if (!shouldRunDevTick(process.env)) {
    g.__reelcastDevTick = "off";
    console.log(DEV_TICK_OFF_MESSAGE);
    return;
  }

  const { runTick } = await import("@/server/jobs/tick");
  let running = false;
  g.__reelcastDevTick = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await runTick({ budgetMs: 25_000 });
      // Routine sweeps that found nothing to do every few seconds are noise: log real work, recoveries and errors only.
      const recovered = r.recovered.jobs || r.recovered.tasks || r.recovered.failedJobs;
      if (r.jobsRun || r.tasksRun || recovered || r.errors.length) console.log("[dev tick]", JSON.stringify(r));
    } catch (e) {
      console.error("[dev tick] failed", e);
    } finally {
      running = false;
    }
  }, 5_000);
  console.log("[dev tick] job runner started (every 5s)");
}
