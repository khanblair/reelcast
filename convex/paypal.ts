import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

const subscriptionStatusValidator = v.union(
  v.literal("approval_pending"),
  v.literal("active"),
  v.literal("suspended"),
  v.literal("cancelled"),
  v.literal("expired"),
);

/** Records a freshly-created PayPal subscription. Called right after createSubscription. */
export const internalRecordSubscription = internalMutation({
  args: {
    userId: v.id("users"),
    subscriptionId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("paypalSubscriptions", {
      userId: args.userId,
      subscriptionId: args.subscriptionId,
      status: "approval_pending",
    });
    await ctx.db.patch(args.userId, {
      paypalSubscriptionId: args.subscriptionId,
      subscriptionStatus: "approval_pending",
    });
  },
});

/**
 * Applies a subscription status to the matching paypalSubscriptions row and
 * the owning user. Idempotent — re-running with the same status is a
 * harmless no-op. Called from the webhook handler and from the client-side
 * return-page poll (getSubscription).
 */
export const internalApplySubscriptionStatus = internalMutation({
  args: {
    subscriptionId: v.string(),
    status: subscriptionStatusValidator,
    eventType: v.optional(v.string()),
    nextBillingTime: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const subscription = await ctx.db
      .query("paypalSubscriptions")
      .withIndex("by_subscription_id", (q) => q.eq("subscriptionId", args.subscriptionId))
      .unique();
    if (!subscription) {
      console.warn(`[paypal] no subscription found for id ${args.subscriptionId}`);
      return;
    }

    await ctx.db.patch(subscription._id, {
      status: args.status,
      lastEventType: args.eventType,
      lastCheckedAt: Date.now(),
    });

    const user = await ctx.db.get(subscription.userId);
    if (!user || user.paypalSubscriptionId !== args.subscriptionId) {
      // A newer subscription has since replaced this one on the user record —
      // don't let a stale/duplicate webhook for an old subscription clobber it.
      return;
    }

    if (args.status === "active") {
      await ctx.db.patch(subscription.userId, {
        plan: "pro",
        subscriptionStatus: "active",
        subscriptionRenewsAt: args.nextBillingTime,
      });
    } else if (args.status === "suspended" || args.status === "cancelled" || args.status === "expired") {
      await ctx.db.patch(subscription.userId, {
        subscriptionStatus: args.status,
        // PayPal-cancelled/expired subscriptions lose Pro access immediately
        // (unlike some processors that keep access until period end) since
        // PayPal does not expose a distinct "access until" date on cancel.
        plan: "free",
      });
    }
  },
});

/** The current user's own PayPal subscription history, newest first. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) return [];
    return await ctx.db
      .query("paypalSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(20);
  },
});
