// Port of convex/scheduling.ts.
import { computeSuggestedTimes } from "@/server/lib/content/suggestedTimes";
import { query } from "../rpc/define";

/** Top 3 publish hours (UTC) from the user's history, or `{ suggestedTimes: null, reason }` when there isn't enough data. */
export const getSuggestedTimes = query({
  handler: async (ctx) => computeSuggestedTimes(ctx.db, ctx.userId),
});
