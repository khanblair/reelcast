/** Adapter: Pesapal client -> provider-agnostic `PaymentProvider`. */
import { BillingConfigError, type PaymentProvider } from "../types";
import { createPesapalClient, PesapalError, type PesapalClientOptions } from "./client";
import type { PesapalConfig } from "./config";

export function createPesapalProvider(cfg: PesapalConfig, opts: PesapalClientOptions = {}): PaymentProvider {
  const client = createPesapalClient({ consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret, environment: cfg.environment }, opts);
  return {
    name: "pesapal",

    async submitOrder(input) {
      if (!cfg.ipnId) throw new BillingConfigError("Payments are not fully set up yet (IPN URL not registered).");
      const res = await client.submitOrder({
        id: input.merchantRef,
        currency: input.currency,
        amount: input.amount,
        description: input.description,
        callbackUrl: input.callbackUrl,
        cancellationUrl: input.cancellationUrl,
        notificationId: cfg.ipnId,
        billing: { email: input.buyer.email, firstName: input.buyer.firstName, lastName: input.buyer.lastName },
      });
      return { orderTrackingId: res.orderTrackingId, redirectUrl: res.redirectUrl };
    },

    async getStatus(orderTrackingId) {
      const s = await client.getTransactionStatus(orderTrackingId);
      return {
        orderTrackingId,
        merchantReference: s.merchantReference,
        statusCode: s.statusCode,
        statusDescription: s.statusDescription,
        amount: s.amount,
        currency: s.currency,
        confirmationCode: s.confirmationCode,
        paymentMethod: s.paymentMethod,
      };
    },

    async cancelOrder(orderTrackingId) {
      const r = await client.cancelOrder(orderTrackingId);
      if (!r.cancelled) throw new PesapalError("api", "Pesapal did not cancel the order");
    },
  };
}
