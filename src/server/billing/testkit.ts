/**
 * Test helpers for the billing suites (not a test file, never imported by app code).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { paymentOrders, subscriptions, users } from "@/db/schema";
import type { BillingDeps, OrderRow, SubRow } from "./core";
import type { PaymentProvider, ProviderSubmitInput, VerifiedStatus } from "./types";

export type FakeProvider = PaymentProvider & {
  submitted: ProviderSubmitInput[];
  cancelled: string[];
  statusCalls: string[];
  /** tracking id -> status to return from getStatus (unset ids throw, like a provider outage) */
  statuses: Map<string, VerifiedStatus>;
  failNextSubmit: boolean;
  submitDelayMs: number;
};

export function fakeProvider(): FakeProvider {
  const p: FakeProvider = {
    name: "pesapal",
    submitted: [],
    cancelled: [],
    statusCalls: [],
    statuses: new Map(),
    failNextSubmit: false,
    submitDelayMs: 0,
    async submitOrder(input) {
      if (p.submitDelayMs) await new Promise((r) => setTimeout(r, p.submitDelayMs));
      if (p.failNextSubmit) {
        p.failNextSubmit = false;
        throw new Error("provider exploded");
      }
      p.submitted.push(input);
      return { orderTrackingId: randomUUID(), redirectUrl: `https://pay.pesapal.com/checkout/${input.merchantRef}` };
    },
    async getStatus(id) {
      p.statusCalls.push(id);
      const s = p.statuses.get(id);
      if (!s) throw new Error(`no status scripted for ${id}`);
      return s;
    },
    async cancelOrder(id) {
      p.cancelled.push(id);
    },
  };
  return p;
}

export function mkDeps(provider: PaymentProvider, over: Partial<BillingDeps> = {}): BillingDeps {
  return { provider, prices: { pro: 19, elite: 49 }, currency: "USD", appUrl: "https://app.test", ...over };
}

/** A COMPLETED status that matches the order exactly (override fields to forge mismatches). */
export function completed(order: Pick<OrderRow, "orderTrackingId" | "merchantRef" | "amount" | "currency">, over: Partial<VerifiedStatus> = {}): VerifiedStatus {
  return {
    orderTrackingId: order.orderTrackingId ?? randomUUID(),
    merchantReference: order.merchantRef,
    statusCode: 1,
    statusDescription: "Completed",
    amount: Number(order.amount),
    currency: order.currency,
    confirmationCode: "CONF123",
    paymentMethod: "MPESA",
    ...over,
  };
}

export async function getOrder(db: DbLike, id: string): Promise<OrderRow> {
  const [o] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, id)).limit(1);
  if (!o) throw new Error("order missing");
  return o;
}

export async function getSub(db: DbLike, id: string): Promise<SubRow> {
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
  if (!s) throw new Error("subscription missing");
  return s;
}

export async function getUser(db: DbLike, id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return u;
}

/** Wipe the user's billing rows and set a known plan (inside a rolled-back transaction). */
export async function resetUser(db: DbLike, userId: string, plan: "free" | "pro" | "elite", source: "default" | "subscription" | "admin") {
  await db.delete(paymentOrders).where(eq(paymentOrders.userId, userId));
  await db.delete(subscriptions).where(eq(subscriptions.userId, userId));
  await db.update(users).set({ plan, planSource: source }).where(eq(users.id, userId));
}

export async function mkSub(
  db: DbLike,
  userId: string,
  o: { plan?: "pro" | "elite"; status?: SubRow["status"]; periodEnd: Date; periodStart?: Date; graceUntil?: Date | null; cancelAtPeriodEnd?: boolean; pendingPlan?: SubRow["pendingPlan"] },
): Promise<SubRow> {
  const [s] = await db
    .insert(subscriptions)
    .values({
      userId,
      plan: o.plan ?? "pro",
      status: o.status ?? "active",
      periodStart: o.periodStart ?? new Date(o.periodEnd.getTime() - 30 * 86_400_000),
      periodEnd: o.periodEnd,
      graceUntil: o.graceUntil ?? null,
      cancelAtPeriodEnd: o.cancelAtPeriodEnd ?? false,
      pendingPlan: o.pendingPlan ?? null,
    })
    .returning();
  return s;
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
