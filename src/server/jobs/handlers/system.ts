import type { HandlerSet } from "../handlers";
import { checkAllChannels } from "@/server/lib/publish/oauth";

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
  ],
};
