// Port of convex/analytics.ts (getDashboardStats only; the internal helpers belong to their callers).
import { getDashboardStats as computeDashboardStats } from "@/server/lib/content/stats";
import { query } from "../rpc/define";

export const getDashboardStats = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return null;
    return computeDashboardStats(ctx.db, ctx.userId);
  },
});
