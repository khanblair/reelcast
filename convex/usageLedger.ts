import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

type UsageField = "videosUploaded" | "metadataGenerated" | "veoGenerated";

const FREE_LIMITS: Record<UsageField, number> = {
  videosUploaded: 10,
  metadataGenerated: 5,
  veoGenerated: 0,
};

const PRO_LIMITS: Record<UsageField, number> = {
  videosUploaded: 999999,
  metadataGenerated: 999999,
  veoGenerated: 5,
};

function getMonthString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Internal: fetch the usageLedger row for a specific user + month.
export const getForUserMonth = internalQuery({
  args: {
    userId: v.id("users"),
    month: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("usageLedger")
      .withIndex("by_user_month", (q) =>
        q.eq("userId", args.userId).eq("month", args.month)
      )
      .unique();
  },
});

// Internal: increment a usage counter for a user in the current month.
export const increment = internalMutation({
  args: {
    userId: v.id("users"),
    field: v.union(
      v.literal("videosUploaded"),
      v.literal("metadataGenerated"),
      v.literal("veoGenerated")
    ),
  },
  handler: async (ctx, args) => {
    const month = getMonthString();
    const row = await ctx.db
      .query("usageLedger")
      .withIndex("by_user_month", (q) =>
        q.eq("userId", args.userId).eq("month", month)
      )
      .unique();

    if (row) {
      const current = (row[args.field] ?? 0) as number;
      await ctx.db.patch(row._id, { [args.field]: current + 1 });
    } else {
      await ctx.db.insert("usageLedger", {
        userId: args.userId,
        month,
        [args.field]: 1,
      });
    }
  },
});

// Public: returns the usageLedger row for the current user + current month.
export const getCurrentMonth = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) return null;

    const month = getMonthString();
    return await ctx.db
      .query("usageLedger")
      .withIndex("by_user_month", (q) =>
        q.eq("userId", user._id).eq("month", month)
      )
      .unique();
  },
});

// Public: checks whether the current user is within the plan limit for a field.
export const checkLimit = query({
  args: {
    field: v.union(
      v.literal("videosUploaded"),
      v.literal("metadataGenerated"),
      v.literal("veoGenerated")
    ),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found in DB");

    const month = getMonthString();
    const row = await ctx.db
      .query("usageLedger")
      .withIndex("by_user_month", (q) =>
        q.eq("userId", user._id).eq("month", month)
      )
      .unique();

    const used = (row?.[args.field] ?? 0) as number;
    const plan = user.plan ?? "free";
    const limits = plan === "pro" ? PRO_LIMITS : FREE_LIMITS;
    const limit = limits[args.field];

    return {
      used,
      limit,
      allowed: used < limit,
    };
  },
});
