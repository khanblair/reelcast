// Port of convex/usageLedger.ts. Export ONLY rpc definitions from this file.
// Quota metering lives in src/server/lib/usage.ts (consumeQuota/refundQuota). Of the Convex
// public functions only getUsageSummary is used by the UI (billing page); checkLimit and
// getCurrentMonth had no callers. getUsageSummary was deleted from Convex by commit fed3147,
// which left the billing page broken; this restores it on top of getUsage().
import { getUsage, type UsageField } from "@/server/lib/usage";
import { query } from "../rpc/define";

const FIELDS: UsageField[] = ["videosUploaded", "metadataGenerated", "veoGenerated", "aiMessagesUsed"];

/** This month's usage next to the plan limits: { plan, month, usage: { field: { used, limit } } }. */
export const getUsageSummary = query({
  handler: async (ctx) => {
    const u = await getUsage(ctx.db, ctx.userId);
    return {
      plan: u.plan,
      month: u.month,
      usage: Object.fromEntries(FIELDS.map((f) => [f, { used: u.used[f], limit: u.limits[f] }])) as Record<UsageField, { used: number; limit: number }>,
    };
  },
});
