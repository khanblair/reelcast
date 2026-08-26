import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// ---------------------------------------------------------------------------
// Lemon Squeezy billing — plain (non-"use node") DB reads/writes.
//
// The webhook signature verification lives in convex/http.ts (Web Crypto,
// default runtime). The checkout-URL creation action lives in
// convex/actions/billing.ts ("use node", calls the Lemon Squeezy REST API).
// Both call into the internal mutations/queries below to touch the DB.
// ---------------------------------------------------------------------------

const subscriptionStatusValidator = v.union(
  v.literal("on_trial"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("past_due"),
  v.literal("unpaid"),
  v.literal("cancelled"),
  v.literal("expired"),
);

/**
 * Idempotency guard for webhook processing. Checks whether an eventId has
 * already been recorded; if not, records it in the same call. Callers should
 * skip all further processing when `alreadyProcessed` is true.
 */
export const checkAndRecordEvent = internalMutation({
  args: {
    eventId: v.string(),
    eventName: v.string(),
    userId: v.optional(v.id("users")),
    subscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ alreadyProcessed: boolean }> => {
    const existing = await ctx.db
      .query("billingEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();

    if (existing) {
      return { alreadyProcessed: true };
    }

    await ctx.db.insert("billingEvents", {
      eventId: args.eventId,
      eventName: args.eventName,
      userId: args.userId,
      subscriptionId: args.subscriptionId,
      processedAt: Date.now(),
    });

    return { alreadyProcessed: false };
  },
});

/** Internal lookup used by the webhook handler to map a subscription back to a Convex user. */
export const getUserByLemonSqueezyCustomerId = internalQuery({
  args: { customerId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_lemonsqueezy_customer_id", (q) => q.eq("lemonSqueezyCustomerId", args.customerId))
      .unique();
  },
});

/** Internal lookup used by the webhook handler to map a subscription back to a Convex user. */
export const getUserByLemonSqueezySubscriptionId = internalQuery({
  args: { subscriptionId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_lemonsqueezy_subscription_id", (q) => q.eq("lemonSqueezySubscriptionId", args.subscriptionId))
      .unique();
  },
});

/**
 * Applies an "activate/renew" style event (subscription_created, updated,
 * resumed, payment_success while active/on_trial): upgrades the user to Pro
 * and records the current Lemon Squeezy subscription state.
 */
export const activateSubscription = internalMutation({
  args: {
    userId: v.id("users"),
    lemonSqueezyCustomerId: v.string(),
    lemonSqueezySubscriptionId: v.string(),
    lemonSqueezyVariantId: v.string(),
    subscriptionStatus: subscriptionStatusValidator,
    subscriptionRenewsAt: v.optional(v.number()),
    subscriptionEndsAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      plan: "pro",
      lemonSqueezyCustomerId: args.lemonSqueezyCustomerId,
      lemonSqueezySubscriptionId: args.lemonSqueezySubscriptionId,
      lemonSqueezyVariantId: args.lemonSqueezyVariantId,
      subscriptionStatus: args.subscriptionStatus,
      subscriptionRenewsAt: args.subscriptionRenewsAt,
      subscriptionEndsAt: args.subscriptionEndsAt,
    });
  },
});

/**
 * subscription_cancelled: the customer cancelled but Lemon Squeezy keeps
 * access active until the current period ends. Do NOT downgrade the plan
 * here — only record the status + end date. The plan is downgraded when
 * subscription_expired actually fires.
 */
export const markCancelled = internalMutation({
  args: {
    userId: v.id("users"),
    subscriptionEndsAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      subscriptionStatus: "cancelled",
      subscriptionEndsAt: args.subscriptionEndsAt,
    });
  },
});

/** subscription_expired: access period is over — downgrade to Free. */
export const expireSubscription = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      plan: "free",
      subscriptionStatus: "expired",
    });
  },
});
