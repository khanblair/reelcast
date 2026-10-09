// Port of convex/actions/backfillDurations.ts (the `debugVideoState` CLI helper is dev tooling and not ported).
// Export ONLY rpc definitions from this file.
import { backfillDurationsForUser } from "@/server/lib/publish/backfill";
import { action } from "../../rpc/define";

/**
 * Fill in `duration` for the caller's videos from Cloudinary (and switch videos over 60s to "video"
 * mode). Time-boxed to ~25s: when more remain, `remaining > 0` and running it again continues.
 */
export const backfillDurations = action({
  handler: async (ctx) => backfillDurationsForUser(ctx.db, ctx.userId),
});
