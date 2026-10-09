/**
 * The brief's headline invariant, through the REAL entry points: a browser callback and Pesapal's IPN
 * (and a retried IPN / second callback) all arrive at once for one completed order. Exactly one of them
 * may extend the period. Needs separate connections, so it commits throwaway rows and removes them.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { notifications, paymentEvents, paymentOrders, subscriptions, users } from "@/db/schema";
import { sql } from "drizzle-orm";
import { handleCallback } from "./pesapal/callback";
import { handleIpn } from "./pesapal/ipn";
import { DAY, completed, fakeProvider, getSub, getUser } from "./testkit";

setDefaultTimeout(120_000);

const APP = "https://app.test";
const startedAt = new Date();
let userId = "";
let saved: { exists: boolean; plan?: string; planSource?: string } = { exists: false };
let savedAppUrl: string | undefined;
const subIds: string[] = [];
const orderIds: string[] = [];
const trackingIds: string[] = [];

async function cleanup() {
  if (trackingIds.length) await db.delete(paymentEvents).where(inArray(paymentEvents.orderTrackingId, trackingIds));
  if (orderIds.length) await db.delete(paymentOrders).where(inArray(paymentOrders.id, orderIds));
  if (subIds.length) await db.delete(subscriptions).where(inArray(subscriptions.id, subIds));
  await db.delete(notifications).where(and(eq(notifications.userId, userId), gte(notifications.createdAt, startedAt), inArray(notifications.title, ["Payment received"])));
  if (saved.exists) await db.update(users).set({ plan: saved.plan as "free", planSource: saved.planSource as "default" }).where(eq(users.id, userId));
}

beforeAll(async () => {
  savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = APP;
  const rows = (await db.execute(sql`select id, email from auth.users order by created_at limit 1`)) as unknown as { id: string; email: string }[];
  userId = rows[0].id;
  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  if (existing) saved = { exists: true, plan: existing.plan, planSource: existing.planSource };
  else await db.insert(users).values({ id: userId, email: rows[0].email });
  const live = await db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ["approval_pending", "active", "past_due"])));
  if (live.length) throw new Error("Refusing to run: the test user already has a live subscription");
});

afterAll(async () => {
  if (!userId) return;
  await cleanup();
  if (!saved.exists) await db.delete(users).where(eq(users.id, userId));
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
});

describe("callback + IPN racing for one payment", () => {
  test("two IPNs and two browser callbacks at once apply the payment exactly once", async () => {
    try {
      const [sub] = await db.insert(subscriptions).values({ userId, plan: "pro", status: "approval_pending" }).returning();
      subIds.push(sub.id);
      const tracking = randomUUID();
      trackingIds.push(tracking);
      const [order] = await db
        .insert(paymentOrders)
        .values({ userId, subscriptionId: sub.id, merchantRef: `in_race_${randomUUID().slice(0, 12)}`, orderTrackingId: tracking, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" })
        .returning();
      orderIds.push(order.id);

      const provider = fakeProvider();
      provider.statuses.set(tracking, completed(order));
      const deps = { db, getProvider: async () => provider };
      const q = `OrderTrackingId=${tracking}&OrderMerchantReference=${order.merchantRef}`;
      const ipn = () => handleIpn(new Request(`${APP}/api/webhooks/pesapal/ipn?${q}&OrderNotificationType=IPNCHANGE`), deps);
      const callback = () => handleCallback(new Request(`${APP}/api/billing/callback?${q}&OrderNotificationType=CALLBACKURL`), deps);

      const [i1, c1, i2, c2] = await Promise.all([ipn(), callback(), ipn(), callback()]);

      for (const r of [i1, i2]) {
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ orderNotificationType: "IPNCHANGE", orderTrackingId: tracking, orderMerchantReference: order.merchantRef, status: 200 });
      }
      for (const r of [c1, c2]) {
        expect(r.status).toBe(303);
        expect(r.headers.get("location")).toBe(`${APP}/billing?status=success`);
      }
      expect(provider.statusCalls).toHaveLength(4); // every entry point verified with the provider itself

      const after = await getSub(db, sub.id);
      expect(after.status).toBe("active");
      expect((after.periodEnd as Date).getTime() - (after.periodStart as Date).getTime()).toBe(30 * DAY); // one extension
      expect(await getUser(db, userId)).toMatchObject({ plan: "pro", planSource: "subscription" });
      const paid = await db.select().from(paymentOrders).where(eq(paymentOrders.id, order.id));
      expect(paid[0].appliedAt).not.toBeNull();
      const notes = (await db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.title, "Payment received")))).filter((n) => n.createdAt >= startedAt);
      expect(notes).toHaveLength(1);

      // every notification left an audit row, and all were processed
      const events = await db.select().from(paymentEvents).where(eq(paymentEvents.orderTrackingId, tracking));
      expect(events).toHaveLength(4);
      expect(events.every((e) => e.processedAt !== null && e.error === null)).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
