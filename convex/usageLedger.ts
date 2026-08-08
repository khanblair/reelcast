import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";
import type { Id } from "./_generated/dataModel";

export type UsageField = "videosUploaded" | "metadataGenerated" | "veoGenerated" | "aiMessagesUsed";

const FREE_LIMITS: Record<UsageField, number> = {
  videosUploaded: 10,
  metadataGenerated: 5,
  veoGenerated: 0,
  aiMessagesUsed: 0,
};

const PRO_LIMITS: Record<UsageField, number> = {
  videosUploaded: 999999,
  metadataGenerated: 999999,
  veoGenerated: 5,
  aiMessagesUsed: 200,
};

const ELITE_LIMITS: Record<UsageField, number> = {
  videosUploaded: 999999,
  metadataGenerated: 999999,
  veoGenerated: 999999,
  aiMessagesUsed: 1000,
};

function getPlanLimits(plan: string | undefined): Record<UsageField, number> {
  if (plan === "elite") return ELITE_LIMITS;
  if (plan === "pro") return PRO_LIMITS;
  return FREE_LIMITS;
}

function getMonthString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Helper for use inside mutations (cannot call other mutations).
// Reads the ledger, checks limit, increments — all in one transaction.
export async function consumeQuotaInMutation(
  ctx: { db: any },
  userId: Id<"users">,
  field: UsageField
): Promise<{ used: number; limit: number }> {
  const month = getMonthString();
  const user = await ctx.db.get(userId);
  const limits = getPlanLimits(user?.plan);
  const limit = limits[field];

  const row = await ctx.db
    .query("usageLedger")
    .withIndex("by_user_month", (q: any) => q.eq("userId", userId).eq("month", month))
    .unique();

  const used = ((row?.[field] ?? 0) as number);

  if (used >= limit) {
    const planLabel = user?.plan ?? "free";
    throw new Error(`PLAN_LIMIT_EXCEEDED:${field}:${planLabel}`);
  }

  if (row) {
    await ctx.db.patch(row._id, { [field]: used + 1 });
  } else {
    await ctx.db.insert("usageLedger", { userId, month, [field]: 1 });
  }

  return { used: used + 1, limit };
}

// Internal: atomic check-then-increment — for use from actions via ctx.runMutation.
export const internalConsumeQuota = internalMutation({
  args: {
    userId: v.id("users"),
    field: v.union(
      v.literal("videosUploaded"),
      v.literal("metadataGenerated"),
      v.literal("veoGenerated"),
      v.literal("aiMessagesUsed")
    ),
  },
  handler: async (ctx, args): Promise<{ used: number; limit: number }> => {
    return consumeQuotaInMutation(ctx, args.userId, args.field);
  },
});

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

// Internal: increment a usage counter for a user in the current month (no limit check).
export const increment = internalMutation({
  args: {
    userId: v.id("users"),
    field: v.union(
      v.literal("videosUploaded"),
      v.literal("metadataGenerated"),
      v.literal("veoGenerated"),
      v.literal("aiMessagesUsed")
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
      v.literal("veoGenerated"),
      v.literal("aiMessagesUsed")
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
    const limits = getPlanLimits(user.plan);
    const limit = limits[args.field];

    return {
      used,
      limit,
      allowed: used < limit,
    };
  },
});
