/**
 * DTO builders for the billing UI. Raw payment_* / subscription rows never leave the server:
 * no tracking ids, confirmation codes or provider URLs.
 */
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { paymentOrders, subscriptions } from "@/db/schema";
import { getUsageWithPlanSource } from "@/server/lib/usage";
import { LIVE_STATUSES, renewalPlan, type OrderRow, type SubRow } from "./core";
import { RENEWAL_LEAD_MS, planRank, type PlanPrices } from "./plans";
import { paymentsReady } from "./service";

export type PaymentDto = {
  id: string;
  purpose: OrderRow["purpose"];
  plan: OrderRow["plan"];
  amount: number;
  currency: string;
  /** review = completed at the provider but not applied (amount mismatch / stale upgrade): support will follow up. */
  status: "paid" | "pending" | "failed" | "reversed" | "review";
  paymentMethod: string | null;
  createdAt: Date;
  paidAt: Date | null;
};

/** The only payment_orders columns the UI ever sees (never the tracking id, confirmation code or redirect link). */
const PAYMENT_COLUMNS = {
  id: paymentOrders.id,
  purpose: paymentOrders.purpose,
  plan: paymentOrders.plan,
  amount: paymentOrders.amount,
  currency: paymentOrders.currency,
  statusCode: paymentOrders.statusCode,
  appliedAt: paymentOrders.appliedAt,
  paymentMethod: paymentOrders.paymentMethod,
  createdAt: paymentOrders.createdAt,
};
type PaymentRow = Pick<OrderRow, keyof typeof PAYMENT_COLUMNS>;

export function paymentDto(o: PaymentRow): PaymentDto {
  let status: PaymentDto["status"] = "pending";
  if (o.statusCode === 3) status = "reversed";
  else if (o.appliedAt) status = "paid";
  else if (o.statusCode === 1) status = "review";
  else if (o.statusCode === 2) status = "failed";
  return {
    id: o.id,
    purpose: o.purpose,
    plan: o.plan,
    amount: Number(o.amount),
    currency: o.currency,
    status,
    paymentMethod: o.paymentMethod,
    createdAt: o.createdAt,
    paidAt: o.appliedAt,
  };
}

/** Orders that were actually opened at the provider (sweep-created, never-opened renewal rows are not history). */
const visibleOrders = (userId: string) =>
  and(eq(paymentOrders.userId, userId), isNotNull(paymentOrders.orderTrackingId), or(isNull(paymentOrders.statusText), notInArray(paymentOrders.statusText, ["superseded"])));

export async function listPaymentDtos(db: DbLike, userId: string, limit: number): Promise<PaymentDto[]> {
  const rows = await db.select(PAYMENT_COLUMNS).from(paymentOrders).where(visibleOrders(userId)).orderBy(desc(paymentOrders.createdAt)).limit(limit);
  return rows.map(paymentDto);
}

export function subscriptionDto(sub: SubRow, now: Date) {
  const next = renewalPlan(sub);
  const msLeft = sub.periodEnd ? sub.periodEnd.getTime() - now.getTime() : null;
  const downgradePending = planRank(next) < planRank(sub.plan);
  // Mirrors the checks in core.createCheckout("renewal").
  const renewalOpen =
    sub.status === "past_due" ||
    (sub.status === "active" && msLeft !== null && msLeft <= RENEWAL_LEAD_MS && (!downgradePending || msLeft <= 0));
  return {
    id: sub.id,
    plan: sub.plan,
    status: sub.status,
    periodStart: sub.periodStart,
    periodEnd: sub.periodEnd,
    graceUntil: sub.graceUntil,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    pendingPlan: sub.pendingPlan,
    nextPlan: next,
    renewalOpen,
  };
}

/**
 * Four statements, issued together (a free user, a user with a subscription and a user with a pending renewal all
 * cost the same): the subscription (+ its open renewal order), the recent payments, the plan with this month's usage,
 * and the payment configuration.
 */
export async function buildBillingStatus(db: DbLike, userId: string, cfg: { prices: PlanPrices; currency: string; now?: Date }) {
  const now = cfg.now ?? new Date();

  const [subRows, payments, usage, ready] = await Promise.all([
    // The live subscription if there is one (the partial unique index subscriptions_one_live_idx allows at most one
    // row with status in LIVE_STATUSES per user), otherwise the newest one of any status. Its open renewal order
    // rides along on the same row, only for an active / past_due subscription: the newest unapplied, not-dead one.
    db
      .select({
        sub: subscriptions,
        renewal: { id: paymentOrders.id, plan: paymentOrders.plan, amount: paymentOrders.amount, currency: paymentOrders.currency, createdAt: paymentOrders.createdAt },
      })
      .from(subscriptions)
      .leftJoin(
        paymentOrders,
        and(
          eq(paymentOrders.subscriptionId, subscriptions.id),
          inArray(subscriptions.status, ["active", "past_due"]),
          eq(paymentOrders.purpose, "renewal"),
          isNull(paymentOrders.appliedAt),
          or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0)),
          or(isNull(paymentOrders.statusText), notInArray(paymentOrders.statusText, ["submit_failed", "submit_abandoned", "superseded", "ABANDONED"])),
        ),
      )
      .where(eq(subscriptions.userId, userId))
      .orderBy(desc(inArray(subscriptions.status, [...LIVE_STATUSES])), desc(subscriptions.createdAt), desc(paymentOrders.createdAt))
      .limit(1),
    listPaymentDtos(db, userId, 5),
    getUsageWithPlanSource(db, userId),
    paymentsReady(db),
  ]);
  const sub: SubRow | undefined = subRows[0]?.sub;
  const renewalOrder = subRows[0]?.renewal ?? undefined;

  const items: Record<string, { used: number; limit: number }> = {};
  for (const field of Object.keys(usage.used) as (keyof typeof usage.used)[]) items[field] = { used: usage.used[field], limit: usage.limits[field] };

  return {
    plan: usage.plan,
    planSource: usage.planSource,
    selfServe: usage.planSource !== "admin",
    paymentsEnabled: ready.configured && ready.ipnRegistered && !!process.env.NEXT_PUBLIC_APP_URL,
    currency: cfg.currency,
    prices: cfg.prices,
    subscription: sub ? subscriptionDto(sub, now) : null,
    renewalOrder: renewalOrder
      ? { id: renewalOrder.id, plan: renewalOrder.plan, amount: Number(renewalOrder.amount), currency: renewalOrder.currency, createdAt: renewalOrder.createdAt }
      : null,
    payments,
    usage: { month: usage.month, items },
  };
}
