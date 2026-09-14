"use node";

import { v } from "convex/values";
import { action, internalAction, ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { getCurrentUserOrThrow } from "../lib/auth";
import {
  getAccessToken,
  createProduct,
  createPlan,
  createSubscription,
  getSubscription,
  createWebhook,
  listWebhooks,
  findApproveLink,
  type PayPalEnvironment,
} from "../lib/paypal";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://reelcast.app";
const PRO_PRICE_USD = Number(process.env.NEXT_PUBLIC_PRO_PRICE_USD ?? "19");

async function getPaypalCredentials(ctx: ActionCtx) {
  const settings = await ctx.runQuery(internal.admin.platformSettings.getInternal, {});
  if (!settings?.paypalClientId || !settings?.paypalClientSecret) {
    throw new Error("PayPal is not configured. Set the client ID/secret in Admin \u2192 Settings.");
  }
  if (!settings.paypalPlanId) {
    throw new Error("PayPal billing plan has not been created yet. Ask an admin to run setup in Admin \u2192 Settings.");
  }
  const env: PayPalEnvironment = settings.paypalEnvironment ?? "sandbox";
  return {
    env,
    clientId: settings.paypalClientId as string,
    clientSecret: settings.paypalClientSecret as string,
    planId: settings.paypalPlanId as string,
  };
}

function subscriptionStatusFromPaypal(status: string): "approval_pending" | "active" | "suspended" | "cancelled" | "expired" {
  switch (status) {
    case "APPROVAL_PENDING":
    case "APPROVED":
      return "approval_pending";
    case "ACTIVE":
      return "active";
    case "SUSPENDED":
      return "suspended";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    default:
      return "approval_pending";
  }
}

/**
 * Creates a PayPal subscription for the current authenticated user to
 * upgrade to Pro, and returns the hosted "approve" URL to redirect them to.
 * The subscription only becomes ACTIVE after the customer approves it on
 * PayPal's side and PayPal calls us back (webhook + return-page poll).
 */
export const createCheckoutUrl = action({
  args: {},
  handler: async (ctx): Promise<{ redirectUrl: string }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user) throw new Error("User not found.");

    const { env, clientId, clientSecret, planId } = await getPaypalCredentials(ctx);
    const token = await getAccessToken(env, clientId, clientSecret);

    const subscription = await createSubscription(
      env,
      token,
      planId,
      user._id,
      user.email,
      `${APP_URL}/settings?billing=callback`,
      `${APP_URL}/settings?billing=cancel`,
    );

    const approveUrl = findApproveLink(subscription.links);
    if (!approveUrl) throw new Error("PayPal did not return an approval URL.");

    await ctx.runMutation(internal.paypal.internalRecordSubscription, {
      userId: user._id,
      subscriptionId: subscription.id,
    });

    return { redirectUrl: approveUrl };
  },
});

/**
 * Internal: fetches the live subscription status from PayPal and applies
 * it. Called from the webhook handler (no user context) and from the
 * public checkSubscriptionStatus wrapper below (user-scoped, called from
 * the /settings return page after checkout).
 */
export const internalCheckSubscriptionStatus = internalAction({
  args: { subscriptionId: v.string() },
  handler: async (ctx, args): Promise<{ status: string }> => {
    const { env, clientId, clientSecret } = await getPaypalCredentials(ctx);
    const token = await getAccessToken(env, clientId, clientSecret);
    const result = await getSubscription(env, token, args.subscriptionId);
    const status = subscriptionStatusFromPaypal(result.status);
    const nextBillingTime = result.billing_info?.next_billing_time
      ? new Date(result.billing_info.next_billing_time).getTime()
      : undefined;

    await ctx.runMutation(internal.paypal.internalApplySubscriptionStatus, {
      subscriptionId: args.subscriptionId,
      status,
      nextBillingTime,
    });

    return { status };
  },
});

/**
 * Public: same as internalCheckSubscriptionStatus, but scoped to the
 * calling user's own subscription. Called from the /settings checkout
 * return page.
 */
export const checkSubscriptionStatus = action({
  args: { subscriptionId: v.string() },
  handler: async (ctx, args): Promise<{ status: string }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user) throw new Error("User not found.");
    if (user.paypalSubscriptionId !== args.subscriptionId) {
      throw new Error("This subscription does not belong to your account.");
    }
    return ctx.runAction(internal.actions.paypal.internalCheckSubscriptionStatus, {
      subscriptionId: args.subscriptionId,
    });
  },
});

/**
 * Admin-only, one-time setup: creates the "Reelcast Pro" catalog product
 * and its $PRO_PRICE_USD/month billing plan, storing both ids. Re-running
 * this creates a NEW product+plan each time (PayPal has no idempotent
 * upsert-by-name) — only run it once per environment (sandbox vs live).
 */
export const setupBilling = action({
  args: {},
  handler: async (ctx): Promise<{ productId: string; planId: string }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user?.isAdmin) throw new Error("Admin required");

    const settings = await ctx.runQuery(internal.admin.platformSettings.getInternal, {});
    if (!settings?.paypalClientId || !settings?.paypalClientSecret) {
      throw new Error("Set the PayPal client ID/secret before running setup.");
    }
    const env: PayPalEnvironment = settings.paypalEnvironment ?? "sandbox";
    const token = await getAccessToken(env, settings.paypalClientId, settings.paypalClientSecret);

    const product = await createProduct(env, token, "Reelcast Pro", "Reelcast Pro monthly subscription");
    const plan = await createPlan(env, token, product.id, "Reelcast Pro Monthly", PRO_PRICE_USD);

    await ctx.runMutation(internal.admin.platformSettings.internalSetPaypalCatalog, {
      productId: product.id,
      planId: plan.id,
    });

    return { productId: product.id, planId: plan.id };
  },
});

/**
 * Admin-only: registers this deployment's webhook endpoint with PayPal and
 * stores the returned webhook_id (needed to verify incoming webhook
 * signatures). Idempotent — if a webhook for this exact URL already exists
 * on the PayPal app (e.g. from a previous run, or NEXT_PUBLIC_CONVEX_SITE_URL
 * hasn't changed), it's looked up and reused instead of erroring with
 * PayPal's "Webhook URL already exists". Must be re-run if
 * NEXT_PUBLIC_CONVEX_SITE_URL changes (e.g. moving from a dev deployment to
 * production), since that produces a new URL with no existing match.
 */
export const registerWebhook = action({
  args: {},
  handler: async (ctx): Promise<{ webhookId: string }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user?.isAdmin) throw new Error("Admin required");

    const settings = await ctx.runQuery(internal.admin.platformSettings.getInternal, {});
    if (!settings?.paypalClientId || !settings?.paypalClientSecret) {
      throw new Error("Set the PayPal client ID/secret before registering the webhook.");
    }
    const env: PayPalEnvironment = settings.paypalEnvironment ?? "sandbox";
    const token = await getAccessToken(env, settings.paypalClientId, settings.paypalClientSecret);

    const siteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
    if (!siteUrl) throw new Error("NEXT_PUBLIC_CONVEX_SITE_URL is not set in this Convex deployment's env.");
    const webhookUrl = `${siteUrl}/webhooks/paypal`;

    const existing = await listWebhooks(env, token);
    const match = existing.webhooks.find((w) => w.url === webhookUrl);

    const webhookId = match
      ? match.id
      : (await createWebhook(env, token, webhookUrl)).id;

    await ctx.runMutation(internal.admin.platformSettings.internalSetPaypalCatalog, {
      webhookId,
    });

    return { webhookId };
  },
});
