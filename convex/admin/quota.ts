import { v } from "convex/values";
import { query, internalMutation } from "../_generated/server";

/**
 * Return today's YouTube quota usage row for a specific user.
 * Returns null if the user has not used any quota today.
 */
export const getTodayQuotaUsage = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    return await ctx.db
      .query("youtubeQuotaUsage")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", args.userId).eq("date", today),
      )
      .unique();
  },
});

/**
 * Return all users who have consumed YouTube quota today, sorted by usage desc.
 * Joins the users table to include the account email.
 */
export const getQuotaOverview = query({
  args: {},
  handler: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    // No index on date alone — scan and filter (table is expected to be small)
    const allUsage = await ctx.db.query("youtubeQuotaUsage").collect();
    const todayUsage = allUsage.filter((u) => u.date === today);

    const rows = await Promise.all(
      todayUsage.map(async (usage) => {
        const user = await ctx.db.get(usage.userId);
        return {
          userId: usage.userId,
          email: user?.email ?? "unknown",
          unitsUsed: usage.unitsUsed,
        };
      }),
    );

    return rows.sort((a, b) => b.unitsUsed - a.unitsUsed);
  },
});

/**
 * Increment (or create) today's quota usage entry for a user.
 * Called from trusted server-side code only.
 */
export const addQuotaUsage = internalMutation({
  args: {
    userId: v.id("users"),
    units: v.number(),
  },
  handler: async (ctx, args) => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    const existing = await ctx.db
      .query("youtubeQuotaUsage")
      .withIndex("by_user_date", (q) =>
        q.eq("userId", args.userId).eq("date", today),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        unitsUsed: existing.unitsUsed + args.units,
      });
    } else {
      await ctx.db.insert("youtubeQuotaUsage", {
        userId: args.userId,
        date: today,
        unitsUsed: args.units,
      });
    }
  },
});
