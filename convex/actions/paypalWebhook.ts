"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getAccessToken, verifyWebhookSignature, type PayPalEnvironment } from "../lib/paypal";

function subscriptionStatusFromEvent(eventType: string): "approval_pending" | "active" | "suspended" | "cancelled" | "expired" | null {
  switch (eventType) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.RE-ACTIVATED":
      return "active";
    case "BILLING.SUBSCRIPTION.SUSPENDED":
      return "suspended";
    case "BILLING.SUBSCRIPTION.CANCELLED":
      return "cancelled";
    case "BILLING.SUBSCRIPTION.EXPIRED":
      return "expired";
    default:
      return null; // e.g. BILLING.SUBSCRIPTION.UPDATED, PAYMENT.SALE.COMPLETED — no direct status mapping
  }
}

/**
 * Verifies a PayPal webhook delivery's signature via PayPal's own
 * verify-webhook-signature API (cert-based, not a local HMAC check — PayPal
 * doesn't offer a pre-shared secret for local verification), then applies
 * the event to the matching subscription if it's a status-changing type.
 * Returns false on signature failure so the HTTP handler can 401.
 */
export const verifyAndApply = internalAction({
  args: {
    rawBody: v.string(),
    authAlgo: v.string(),
    certUrl: v.string(),
    transmissionId: v.string(),
    transmissionSig: v.string(),
    transmissionTime: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const settings = await ctx.runQuery(internal.admin.platformSettings.getInternal, {});
    if (!settings?.paypalClientId || !settings?.paypalClientSecret || !settings?.paypalWebhookId) {
      console.error("[paypal webhook] PayPal is not fully configured (missing credentials or webhook id)");
      return false;
    }
    const env: PayPalEnvironment = settings.paypalEnvironment ?? "sandbox";
    const token = await getAccessToken(env, settings.paypalClientId, settings.paypalClientSecret);

    const webhookEvent = JSON.parse(args.rawBody);

    const verified = await verifyWebhookSignature(env, token, {
      authAlgo: args.authAlgo,
      certUrl: args.certUrl,
      transmissionId: args.transmissionId,
      transmissionSig: args.transmissionSig,
      transmissionTime: args.transmissionTime,
      webhookId: settings.paypalWebhookId,
      webhookEvent,
    });
    if (!verified) return false;

    const eventType: string | undefined = webhookEvent?.event_type;
    const subscriptionId: string | undefined = webhookEvent?.resource?.id;
    if (!eventType || !subscriptionId) return true; // verified, but nothing actionable

    const status = subscriptionStatusFromEvent(eventType);
    if (!status) return true; // verified, informational event only

    const nextBillingTimeRaw: string | undefined = webhookEvent?.resource?.billing_info?.next_billing_time;
    const nextBillingTime = nextBillingTimeRaw ? new Date(nextBillingTimeRaw).getTime() : undefined;

    await ctx.runMutation(internal.paypal.internalApplySubscriptionStatus, {
      subscriptionId,
      status,
      eventType,
      nextBillingTime,
    });

    return true;
  },
});
