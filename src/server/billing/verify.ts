/**
 * Turns an UNTRUSTED notification (IPN or browser callback: only OrderTrackingId /
 * OrderMerchantReference / OrderNotificationType, no signature) into a trusted state change:
 * look the order up in OUR database, ask the provider for the real status, then apply it.
 *
 * Verification is the GetTransactionStatus call plus the checks in `applyVerifiedPayment`
 * (merchant reference echo, amount, currency). A forged tracking id either matches no order
 * (nothing is called, nothing is granted) or resolves to a status that does not match.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/client";
import { paymentEvents, paymentOrders } from "@/db/schema";
import { applyVerifiedPayment, type ApplyResult } from "./core";
import type { PaymentProvider } from "./types";

/** Query/body of an IPN or callback. Pesapal 3.0 casing; the legacy 2.0 names are accepted as aliases. */
export const notificationSchema = z.object({
  orderTrackingId: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  merchantRef: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9\-_.:]+$/).optional(),
  notificationType: z.string().trim().max(32).optional(),
});
export type Notification = z.infer<typeof notificationSchema>;

const pick = (src: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
};

/** Merge query string + body (JSON or form) and validate. Returns null when there is no usable tracking id. */
export function parseNotification(sources: Record<string, unknown>[]): Notification | null {
  const merged: Record<string, unknown> = Object.assign({}, ...sources);
  const parsed = notificationSchema.safeParse({
    orderTrackingId: pick(merged, "OrderTrackingId", "orderTrackingId", "pesapal_transaction_tracking_id"),
    merchantRef: pick(merged, "OrderMerchantReference", "orderMerchantReference", "pesapal_merchant_reference"),
    notificationType: pick(merged, "OrderNotificationType", "orderNotificationType", "pesapal_notification_type"),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Audit trail first, before anything can fail. `n` is null when the request did not parse: the row is
 * still written (columns null, capped raw request in the payload). Throws if the row cannot be stored.
 */
export async function recordNotification(
  db: DbLike,
  n: Notification | null,
  source: "ipn" | "callback",
  raw: Record<string, unknown>,
): Promise<string> {
  const [row] = await db
    .insert(paymentEvents)
    .values({
      provider: "pesapal",
      orderTrackingId: n?.orderTrackingId ?? null,
      merchantRef: n?.merchantRef ?? null,
      notificationType: n?.notificationType ?? source.toUpperCase(),
      payload: { source, raw },
    })
    .returning({ id: paymentEvents.id });
  return row.id;
}

export async function markNotificationProcessed(db: DbLike, eventId: string, error: string | null): Promise<void> {
  await db.update(paymentEvents).set({ processedAt: new Date(), error }).where(eq(paymentEvents.id, eventId));
}

export type VerifyResult = ApplyResult;

/**
 * Resolve the order (by tracking id; by merchant reference only while no tracking id is stored yet),
 * fetch the real status and apply it. Never calls the provider for ids we do not know.
 */
export async function verifyAndApply(
  db: DbLike,
  provider: PaymentProvider,
  n: Pick<Notification, "orderTrackingId" | "merchantRef">,
): Promise<VerifyResult> {
  let [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.orderTrackingId, n.orderTrackingId)).limit(1);
  if (!order && n.merchantRef) {
    [order] = await db
      .select()
      .from(paymentOrders)
      .where(and(eq(paymentOrders.merchantRef, n.merchantRef), or(isNull(paymentOrders.orderTrackingId), eq(paymentOrders.orderTrackingId, n.orderTrackingId))))
      .limit(1);
  }
  if (!order) return { outcome: "unknown_order" };
  const status = await provider.getStatus(order.orderTrackingId ?? n.orderTrackingId);
  return applyVerifiedPayment(db, order.id, status);
}
