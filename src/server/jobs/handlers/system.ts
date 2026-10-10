import type { HandlerSet } from "../handlers";
import { checkAllChannels } from "@/server/lib/publish/oauth";
import { runRetention } from "@/server/lib/retention";

/** Platform housekeeping sweeps (agent C1). */
export const handlers: HandlerSet = {
  sweeps: [
    {
      // Every 6 hours: probe every connected YouTube channel so revoked access is noticed before a publish fails.
      // Bounded to 40s (it runs inside a tick); the least recently checked channels go first, so a large
      // fleet is covered across successive runs.
      name: "oauth.health",
      everyMs: 6 * 60 * 60_000,
      run: async ({ db }) => {
        const r = await checkAllChannels(db, { deadline: Date.now() + 40_000 });
        console.log(`[oauth.health] checked ${r.checked}/${r.total} channel(s)`);
      },
    },
    {
      // Every 6 hours: delete what nobody reads any more (finished tasks > 14 d, read notifications > 90 d, YouTube quota
      // counters > 90 d, unmatched payment events), at most 2,000 rows per table per run, one statement per table.
      name: "maintenance.retention",
      everyMs: 6 * 60 * 60_000,
      run: async ({ db, now }) => {
        await runRetention(db, now);
      },
    },
  ],
};
