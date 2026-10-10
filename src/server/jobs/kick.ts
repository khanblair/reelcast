/**
 * Ask the runner to look for work right now instead of waiting for the next cron tick.
 * Call after enqueueing user-initiated work ("Generate", "Publish now"). Best effort:
 * the 1-minute pg_cron tick is the safety net.
 *
 * Production: always. Anywhere else (`next dev`, scripts, tests) it does nothing unless `DEV_TICK=1`,
 * because dev may point at the production database and a 120 s tick there would run real users' jobs
 * (see dev-tick.ts). The `env` and `schedule` parameters exist for tests; callers pass nothing.
 */
import { after } from "next/server";
import { shouldKick, type DevTickEnv } from "./dev-tick";
import { runTick } from "./tick";

export function kickRunner({ env = process.env, schedule = after }: { env?: DevTickEnv; schedule?: typeof after } = {}): void {
  if (!shouldKick(env)) return;
  try {
    schedule(async () => {
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
