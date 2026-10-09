/**
 * Ask the runner to look for work right now instead of waiting for the next cron tick.
 * Call after enqueueing user-initiated work ("Generate", "Publish now"). Best effort:
 * the 1-minute pg_cron tick (prod) / 5s interval (dev) is the safety net.
 */
import { after } from "next/server";
import { runTick } from "./tick";

export function kickRunner(): void {
  try {
    after(async () => {
      try {
        await runTick({ budgetMs: 120_000, concurrency: 2 });
      } catch (e) {
        console.error("[kickRunner]", e);
      }
    });
  } catch {
    // Not inside a request scope (scripts/tests): the periodic tick will pick the work up.
  }
}
