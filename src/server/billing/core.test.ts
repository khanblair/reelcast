/**
 * Billing core against the real database. Everything runs inside a transaction that is rolled back,
 * except the "concurrency" block, which needs separate connections and therefore commits throwaway
 * rows that it deletes afterwards. Pesapal is never contacted: a fake provider stands in.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import { db, type DbLike } from "@/db/client";
import { notifications, paymentEvents, paymentOrders, subscriptions, users } from "@/db/schema";
import { countQueries, inRolledBackTx } from "@/server/testing";
import {
  applyVerifiedPayment,
  cancelAtPeriodEnd,
  changePlan,
  checkoutForUser,
  createCheckout,
  parseUpgradeAnchor,
  renewalBaseRef,
  resumeSubscription,
  runExpirySweep,
  runReconcileSweep,
  runRenewalSweep,
} from "./core";
import { addPeriod, getPlanPrices, prorateUpgradeCents, PERIOD_MS } from "./plans";
import { DAY, HOUR, completed, fakeProvider, getOrder, getSub, getUser, mkDeps, mkSub, resetUser } from "./testkit";
import { verifyAndApply } from "./verify";

setDefaultTimeout(120_000);

const countNotifications = async (d: DbLike, userId: string, title: string) =>
  (await d.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.title, title)))).length;

describe("plans: prices and proration", () => {
  test("Pro defaults to 19 and Elite is not purchasable until configured", () => {
    expect(getPlanPrices({} as NodeJS.ProcessEnv)).toEqual({ pro: 19, elite: null });
    expect(getPlanPrices({ NEXT_PUBLIC_PRO_PRICE_USD: "25" } as unknown as NodeJS.ProcessEnv).pro).toBe(25);
    expect(getPlanPrices({ PLAN_PRO_PRICE: "12.5", PLAN_ELITE_PRICE: "49" } as unknown as NodeJS.ProcessEnv)).toEqual({ pro: 12.5, elite: 49 });
    expect(getPlanPrices({ PLAN_PRO_PRICE: "-3", PLAN_ELITE_PRICE: "abc" } as unknown as NodeJS.ProcessEnv)).toEqual({ pro: 19, elite: null });
  });

  test("proration is linear in the remaining time, in cents, rounded up", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const at = (ms: number) => new Date(now.getTime() + ms);
    const p = (remaining: number, oldPrice = 19, newPrice = 49) => prorateUpgradeCents({ oldPrice, newPrice, periodEnd: at(remaining), now });
    expect(p(PERIOD_MS)).toBe(3000); // full period: the whole difference
    expect(p(PERIOD_MS / 2)).toBe(1500);
    expect(p(PERIOD_MS * 2)).toBe(3000); // never more than one period's worth
    expect(p(0)).toBe(0);
    expect(p(-DAY)).toBe(0); // period already over
    expect(p(DAY)).toBe(100); // 3000 / 30
    expect(p(1)).toBe(1); // a sliver still rounds UP to a cent
    expect(p(PERIOD_MS, 49, 19)).toBe(0); // downgrades are never charged
    expect(p(PERIOD_MS, 19, 19)).toBe(0);
    expect(p(7 * DAY, 19, 33.33)).toBe(Math.ceil((1433 * 7) / 30));
  });

  test("upgrade merchant references anchor to a period_end and fit Pesapal's 50 char limit", () => {
    const subId = randomUUID();
    const end = new Date("2026-06-01T00:00:00Z");
    expect(renewalBaseRef(subId, end).length).toBeLessThanOrEqual(50);
    expect(`${renewalBaseRef(subId, end)}_9`.length).toBeLessThanOrEqual(50);
    const ref = `up_${subId.replace(/-/g, "")}_${Math.floor(end.getTime() / 1000)}_abc`;
    expect(ref.length).toBe(50);
    expect(parseUpgradeAnchor(ref)).toBe(Math.floor(end.getTime() / 1000));
    expect(parseUpgradeAnchor("in_whatever")).toBeNull();
  });
});

describe("createCheckout", () => {
  test("initial: one pending subscription, one submitted order, reused on the second click", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p = fakeProvider();
      const deps = mkDeps(p);
      const a = await createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, deps);
      expect(a.redirectUrl).toStartWith("https://pay.pesapal.com/");
      expect(p.submitted).toHaveLength(1);
      const sent = p.submitted[0];
      expect(sent).toMatchObject({ amount: 19, currency: "USD", callbackUrl: "https://app.test/api/billing/callback", cancellationUrl: "https://app.test/billing?status=cancelled" });
      expect(sent.merchantRef).toMatch(/^in_[0-9a-f]{32}_[0-9a-f]{6}$/);
      expect(sent.merchantRef.length).toBeLessThanOrEqual(50);
      expect(sent.buyer.email).toBe(user.email);

      const subs = await tx.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ status: "approval_pending", plan: "pro" });
      // nothing is granted by merely opening a checkout
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });

      const b = await createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, deps);
      expect(b).toEqual(a);
      expect(p.submitted).toHaveLength(1);

      // switching the plan before paying re-uses the same pending subscription
      const c = await createCheckout(tx, { userId: user.id, plan: "elite", purpose: "initial" }, deps);
      expect(c.orderId).not.toBe(a.orderId);
      expect(p.submitted).toHaveLength(2);
      expect(p.submitted[1].amount).toBe(49);
      expect(await tx.select().from(subscriptions).where(eq(subscriptions.userId, user.id))).toMatchObject([{ plan: "elite", status: "approval_pending" }]);
    });
  });

  test("refuses admin-managed plans, unpriced Elite and a second subscription", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const p = fakeProvider();
      await resetUser(tx, user.id, "elite", "admin");
      await expect(createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, mkDeps(p))).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(changePlan(tx, { userId: user.id, plan: "free" }, mkDeps(p))).rejects.toMatchObject({ code: "BAD_REQUEST" });

      await resetUser(tx, user.id, "free", "default");
      await expect(createCheckout(tx, { userId: user.id, plan: "elite", purpose: "initial" }, mkDeps(p, { prices: { pro: 19, elite: null } }))).rejects.toMatchObject({ code: "BAD_REQUEST" });

      await mkSub(tx, user.id, { periodEnd: new Date(Date.now() + 20 * DAY) });
      await expect(createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, mkDeps(p))).rejects.toMatchObject({ code: "CONFLICT" });
      expect(p.submitted).toHaveLength(0);
    });
  });

  test("a failed submission kills that order; the retry gets a fresh reference", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p = fakeProvider();
      const deps = mkDeps(p);
      p.failNextSubmit = true;
      await expect(createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, deps)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const [dead] = await tx.select().from(paymentOrders).where(eq(paymentOrders.userId, user.id));
      expect(dead).toMatchObject({ statusCode: 2, statusText: "submit_failed", orderTrackingId: null });

      const ok = await createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, deps);
      const orders = await tx.select().from(paymentOrders).where(eq(paymentOrders.userId, user.id));
      expect(orders).toHaveLength(2);
      expect(new Set(orders.map((o) => o.merchantRef)).size).toBe(2);
      expect(ok.orderId).not.toBe(dead.id);
    });
  });

  test("renewal retries after a failure use _1, _2 ... suffixes and stay within 50 chars", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const end = new Date(Date.now() + 2 * DAY);
      const sub = await mkSub(tx, user.id, { periodEnd: end });
      const p = fakeProvider();
      const deps = mkDeps(p);
      p.failNextSubmit = true;
      await expect(checkoutForUser(tx, { userId: user.id, plan: "pro" }, deps)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await checkoutForUser(tx, { userId: user.id, plan: "pro" }, deps);
      const refs = (await tx.select().from(paymentOrders).where(eq(paymentOrders.subscriptionId, sub.id))).map((o) => o.merchantRef).sort();
      const base = renewalBaseRef(sub.id, end);
      expect(refs).toEqual([base, `${base}_1`]);
      expect(refs.every((r) => r.length <= 50 && /^[A-Za-z0-9\-_.:]+$/.test(r))).toBe(true);
    });
  });

  test("the renewal window: too early is refused, inside it works; a scheduled downgrade waits for the period end", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const p = fakeProvider();
      const deps = mkDeps(p);
      await mkSub(tx, user.id, { periodEnd: new Date(Date.now() + 10 * DAY) });
      await expect(checkoutForUser(tx, { userId: user.id, plan: "pro" }, deps)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await tx.update(subscriptions).set({ periodEnd: new Date(Date.now() + 2 * DAY) }).where(eq(subscriptions.userId, user.id));
      await expect(checkoutForUser(tx, { userId: user.id, plan: "elite" }, deps)).rejects.toMatchObject({ code: "BAD_REQUEST" }); // that is changePlan's job
      expect((await checkoutForUser(tx, { userId: user.id, plan: "pro" }, deps)).redirectUrl).toContain("/rn_");

      await resetUser(tx, user.id, "elite", "subscription");
      await mkSub(tx, user.id, { plan: "elite", periodEnd: new Date(Date.now() + 2 * DAY), pendingPlan: "pro" });
      await expect(checkoutForUser(tx, { userId: user.id, plan: "pro" }, deps)).rejects.toThrow(/starts when the current period ends/);
    });
  });
});

describe("applyVerifiedPayment", () => {
  async function pendingOrder(tx: DbLike, userId: string, plan: "pro" | "elite" = "pro") {
    await resetUser(tx, userId, "free", "default");
    const p = fakeProvider();
    const co = await createCheckout(tx, { userId, plan, purpose: "initial" }, mkDeps(p));
    return { p, order: await getOrder(tx, co.orderId) };
  }

  test("a COMPLETED payment activates the plan exactly once", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { order } = await pendingOrder(tx, user.id);
      const now = new Date();
      const r1 = await applyVerifiedPayment(tx, order.id, completed(order), { now });
      expect(r1.outcome).toBe("applied");

      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
      expect(sub).toMatchObject({ status: "active", plan: "pro", graceUntil: null, cancelAtPeriodEnd: false });
      expect(sub.periodEnd?.getTime()).toBe(now.getTime() + 30 * DAY);
      expect(sub.periodStart?.getTime()).toBe(now.getTime());
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
      const paid = await getOrder(tx, order.id);
      expect(paid).toMatchObject({ statusCode: 1, confirmationCode: "CONF123", paymentMethod: "MPESA", subscriptionId: sub.id });
      expect(paid.appliedAt).not.toBeNull();
      expect(await countNotifications(tx, user.id, "Payment received")).toBe(1);

      // replays (IPN retry, callback, reconcile) change nothing
      for (let i = 0; i < 3; i++) {
        const again = await applyVerifiedPayment(tx, order.id, completed(order), { now: new Date(now.getTime() + (i + 1) * HOUR) });
        expect(again.outcome).toBe("already_applied");
      }
      expect((await getSub(tx, sub.id)).periodEnd?.getTime()).toBe(now.getTime() + 30 * DAY);
      expect(await countNotifications(tx, user.id, "Payment received")).toBe(1);
    });
  });

  test("pending and failed statuses grant nothing and a stale poll can't undo a payment", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { order } = await pendingOrder(tx, user.id);
      const pending = await applyVerifiedPayment(tx, order.id, completed(order, { statusCode: 0, statusDescription: "Invalid", amount: 0, currency: null, confirmationCode: null }));
      expect(pending.outcome).toBe("pending");
      expect((await getOrder(tx, order.id)).statusCode).toBe(0);
      const failed = await applyVerifiedPayment(tx, order.id, completed(order, { statusCode: 2, statusDescription: "Failed" }));
      expect(failed.outcome).toBe("failed");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });
      // the customer retries on the same page and pays
      expect((await applyVerifiedPayment(tx, order.id, completed(order))).outcome).toBe("applied");
      // a poll that read "pending" before the payment landed arrives late
      expect((await applyVerifiedPayment(tx, order.id, completed(order, { statusCode: 0 }))).outcome).toBe("already_applied");
      const o = await getOrder(tx, order.id);
      expect(o.statusCode).toBe(1);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro" });
    });
  });

  test("amount, currency and merchant-reference mismatches are rejected, flagged and grant nothing", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { order } = await pendingOrder(tx, user.id);
      const rejectedEvents = async () =>
        tx.select().from(paymentEvents).where(and(eq(paymentEvents.orderTrackingId, order.orderTrackingId as string), like(paymentEvents.notificationType, "REJECTED:%")));

      const underpaid = await applyVerifiedPayment(tx, order.id, completed(order, { amount: 1 }));
      expect(underpaid).toMatchObject({ outcome: "rejected", reason: "amount_mismatch" });
      const wrongCurrency = await applyVerifiedPayment(tx, order.id, completed(order, { currency: "KES" }));
      expect(wrongCurrency).toMatchObject({ outcome: "rejected", reason: "amount_mismatch" });
      const noAmount = await applyVerifiedPayment(tx, order.id, completed(order, { amount: null, currency: null }));
      expect(noAmount).toMatchObject({ outcome: "rejected", reason: "amount_mismatch" });
      const wrongRef = await applyVerifiedPayment(tx, order.id, completed(order, { merchantReference: "in_someone_elses_order" }));
      expect(wrongRef).toMatchObject({ outcome: "rejected", reason: "merchant_reference_mismatch" });
      const noRef = await applyVerifiedPayment(tx, order.id, completed(order, { merchantReference: null }));
      expect(noRef).toMatchObject({ outcome: "rejected", reason: "merchant_reference_missing" });
      const wrongTracking = await applyVerifiedPayment(tx, order.id, completed(order, { orderTrackingId: randomUUID() }));
      expect(wrongTracking).toMatchObject({ outcome: "rejected", reason: "tracking_id_mismatch" });

      const events = await rejectedEvents();
      expect(events.length).toBeGreaterThanOrEqual(5);
      expect(events.every((e) => !!e.error && e.processedAt !== null)).toBe(true);
      const o = await getOrder(tx, order.id);
      expect(o.appliedAt).toBeNull();
      expect(o.statusText).toBe("AMOUNT_MISMATCH");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });
      expect((await tx.select().from(subscriptions).where(eq(subscriptions.userId, user.id)))[0].status).toBe("approval_pending");

      // sub-cent differences from float formatting are fine
      expect((await applyVerifiedPayment(tx, order.id, completed(order, { amount: 19.001, currency: "usd" }))).outcome).toBe("applied");
    });
  });

  test("REVERSED revokes access, records the reason, and stays revoked", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { order } = await pendingOrder(tx, user.id);
      await applyVerifiedPayment(tx, order.id, completed(order));
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro" });

      const rev = await applyVerifiedPayment(tx, order.id, completed(order, { statusCode: 3, statusDescription: "Reversed" }));
      expect(rev.outcome).toBe("reversed");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
      expect(sub.status).toBe("cancelled");
      expect((await getOrder(tx, order.id)).statusCode).toBe(3);
      const events = await tx.select().from(paymentEvents).where(and(eq(paymentEvents.orderTrackingId, order.orderTrackingId as string), eq(paymentEvents.notificationType, "REVERSAL")));
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ reason: "Reversed", wasApplied: true, accessRevoked: true });
      expect(await countNotifications(tx, user.id, "Payment reversed")).toBe(1);

      // repeated reversal notices are no-ops; a stale COMPLETED read can't resurrect the plan
      expect((await applyVerifiedPayment(tx, order.id, completed(order, { statusCode: 3 }))).reason).toBe("already_reversed");
      expect((await applyVerifiedPayment(tx, order.id, completed(order))).outcome).toBe("reversed");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });
      expect((await tx.select().from(subscriptions).where(eq(subscriptions.userId, user.id)))[0].status).toBe("cancelled");
      expect(await countNotifications(tx, user.id, "Payment reversed")).toBe(1);
    });
  });

  test("a reversal never downgrades an admin-granted plan", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { order } = await pendingOrder(tx, user.id);
      await applyVerifiedPayment(tx, order.id, completed(order));
      await tx.update(users).set({ plan: "elite", planSource: "admin" }).where(eq(users.id, user.id));
      await applyVerifiedPayment(tx, order.id, completed(order, { statusCode: 3 }));
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "elite", planSource: "admin" });
    });
  });

  test("a payment never overwrites an admin grant (and says so in the audit log)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { order } = await pendingOrder(tx, user.id);
      await tx.update(users).set({ plan: "elite", planSource: "admin" }).where(eq(users.id, user.id));
      expect((await applyVerifiedPayment(tx, order.id, completed(order))).outcome).toBe("applied");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "elite", planSource: "admin" });
      const notes = await tx.select().from(paymentEvents).where(eq(paymentEvents.notificationType, "NOTE:admin_plan_preserved"));
      expect(notes.length).toBeGreaterThanOrEqual(1);
    });
  });

  test("renewals extend from max(now, period_end): early pays stack, late pays restart", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const end = new Date(Date.now() + 2 * DAY);
      const sub = await mkSub(tx, user.id, { periodEnd: end });
      const p = fakeProvider();
      const deps = mkDeps(p);

      const early = await checkoutForUser(tx, { userId: user.id, plan: "pro" }, deps);
      const earlyOrder = await getOrder(tx, early.orderId);
      expect(earlyOrder.purpose).toBe("renewal");
      await applyVerifiedPayment(tx, earlyOrder.id, completed(earlyOrder));
      const after = await getSub(tx, sub.id);
      expect(after.periodEnd?.getTime()).toBe(end.getTime() + 30 * DAY);
      expect(after.periodStart?.getTime()).toBe(end.getTime());
      expect(after.status).toBe("active");

      // lapsed and paid late: the new period starts at payment time
      const lateEnd = new Date(Date.now() - 1 * DAY);
      await tx.update(subscriptions).set({ status: "past_due", periodEnd: lateEnd, graceUntil: new Date(lateEnd.getTime() + 3 * DAY) }).where(eq(subscriptions.id, sub.id));
      const late = await checkoutForUser(tx, { userId: user.id, plan: "pro" }, deps);
      const lateOrder = await getOrder(tx, late.orderId);
      const payAt = new Date();
      await applyVerifiedPayment(tx, lateOrder.id, completed(lateOrder), { now: payAt });
      const revived = await getSub(tx, sub.id);
      expect(revived).toMatchObject({ status: "active", graceUntil: null });
      expect(revived.periodEnd?.getTime()).toBe(addPeriod(payAt).getTime());
    });
  });

  test("paying for a lapsed subscription revives it instead of being lost", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { order } = await pendingOrder(tx, user.id);
      await tx.update(subscriptions).set({ status: "cancelled" }).where(eq(subscriptions.userId, user.id)); // e.g. the 7 day stale-pending sweep got there first
      expect((await applyVerifiedPayment(tx, order.id, completed(order))).outcome).toBe("applied");
      const subs = await tx.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
      expect(subs.filter((s) => s.status === "active")).toHaveLength(1);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro" });
    });
  });
});

describe("verifyAndApply: untrusted notifications", () => {
  test("a forged or unknown tracking id grants nothing and never reaches the provider", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p = fakeProvider();
      const forged = randomUUID();
      p.statuses.set(forged, { orderTrackingId: forged, merchantReference: "x", statusCode: 1, statusDescription: "Completed", amount: 19, currency: "USD", confirmationCode: "C", paymentMethod: "MPESA" });
      expect(await verifyAndApply(tx, p, { orderTrackingId: forged })).toEqual({ outcome: "unknown_order" });
      expect(await verifyAndApply(tx, p, { orderTrackingId: forged, merchantRef: "in_does_not_exist" })).toEqual({ outcome: "unknown_order" });
      expect(p.statusCalls).toHaveLength(0);

      // a real order whose tracking id we already stored can't be hijacked with a foreign tracking id + its reference
      const co = await createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, mkDeps(fakeProvider()));
      const order = await getOrder(tx, co.orderId);
      expect(await verifyAndApply(tx, p, { orderTrackingId: forged, merchantRef: order.merchantRef })).toEqual({ outcome: "unknown_order" });
      expect(p.statusCalls).toHaveLength(0);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });
    });
  });

  test("an order without a stored tracking id is bound by the echoed merchant reference", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p0 = fakeProvider();
      const co = await createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, mkDeps(p0));
      // simulate "Pesapal accepted the order but we crashed before saving the tracking id"
      await tx.update(paymentOrders).set({ orderTrackingId: null }).where(eq(paymentOrders.id, co.orderId));
      const order = await getOrder(tx, co.orderId);
      const tracking = randomUUID();

      const p = fakeProvider();
      p.statuses.set(tracking, completed(order, { orderTrackingId: tracking, merchantReference: "someone_else" }));
      expect((await verifyAndApply(tx, p, { orderTrackingId: tracking, merchantRef: order.merchantRef })).outcome).toBe("rejected");
      expect((await getOrder(tx, order.id)).orderTrackingId).toBeNull();
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });

      p.statuses.set(tracking, completed(order, { orderTrackingId: tracking }));
      expect((await verifyAndApply(tx, p, { orderTrackingId: tracking, merchantRef: order.merchantRef })).outcome).toBe("applied");
      expect((await getOrder(tx, order.id)).orderTrackingId).toBe(tracking);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro" });
    });
  });
});

describe("sweeps", () => {
  test("expiry: active -> past_due (grace anchored on period_end) -> expired; plan follows plan_source", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const end = new Date(Date.now() - 1 * HOUR);
      const sub = await mkSub(tx, user.id, { periodEnd: end });
      const now = new Date();

      expect(await runExpirySweep(tx, { now, userId: user.id })).toMatchObject({ pastDue: 1, expired: 0 });
      const lapsed = await getSub(tx, sub.id);
      expect(lapsed.status).toBe("past_due");
      expect(lapsed.graceUntil?.getTime()).toBe(end.getTime() + 3 * DAY);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro" }); // still inside grace
      expect(await countNotifications(tx, user.id, "Payment overdue")).toBe(1);
      expect(await runExpirySweep(tx, { now, userId: user.id })).toMatchObject({ pastDue: 0, expired: 0 }); // idempotent

      const later = new Date(end.getTime() + 3 * DAY + HOUR);
      expect(await runExpirySweep(tx, { now: later, userId: user.id })).toMatchObject({ expired: 1 });
      expect((await getSub(tx, sub.id)).status).toBe("expired");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });
      expect(await countNotifications(tx, user.id, "Subscription expired")).toBe(1);
    });
  });

  test("an admin-granted plan survives every lapse", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "elite", "admin");
      const sub = await mkSub(tx, user.id, { plan: "elite", periodEnd: new Date(Date.now() - 10 * DAY) });
      // long outage: one run takes it all the way through grace
      const r = await runExpirySweep(tx, { userId: user.id });
      expect(r.pastDue).toBe(1);
      expect(r.expired).toBe(1);
      expect((await getSub(tx, sub.id)).status).toBe("expired");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "elite", planSource: "admin" });

      // and a cancel-at-period-end one
      await tx.delete(subscriptions).where(eq(subscriptions.userId, user.id));
      await mkSub(tx, user.id, { plan: "elite", periodEnd: new Date(Date.now() - HOUR), cancelAtPeriodEnd: true });
      await runExpirySweep(tx, { userId: user.id });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "elite", planSource: "admin" });
    });
  });

  test("a cancelled subscription keeps access until period end, then ends without a grace period", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const end = new Date(Date.now() + 5 * DAY);
      const sub = await mkSub(tx, user.id, { periodEnd: end });
      expect((await cancelAtPeriodEnd(tx, user.id)).endsAt?.getTime()).toBe(end.getTime());
      await cancelAtPeriodEnd(tx, user.id); // idempotent
      expect(await getSub(tx, sub.id)).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro" });
      expect(await runExpirySweep(tx, { now: new Date(), userId: user.id })).toMatchObject({ cancelled: 0 });

      await resumeSubscription(tx, user.id);
      expect((await getSub(tx, sub.id)).cancelAtPeriodEnd).toBe(false);
      await cancelAtPeriodEnd(tx, user.id);

      expect(await runExpirySweep(tx, { now: new Date(end.getTime() + HOUR), userId: user.id })).toMatchObject({ cancelled: 1, pastDue: 0 });
      expect((await getSub(tx, sub.id)).status).toBe("cancelled");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });
    });
  });

  test("approval_pending subscriptions nobody paid for are dropped after a week", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const [s] = await tx.insert(subscriptions).values({ userId: user.id, plan: "pro", status: "approval_pending" }).returning();
      expect((await runExpirySweep(tx, { userId: user.id })).stale).toBe(0);
      expect((await runExpirySweep(tx, { now: new Date(Date.now() + 8 * DAY), userId: user.id })).stale).toBe(1);
      expect((await getSub(tx, s.id)).status).toBe("cancelled");
      // and the user can start over
      await createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, mkDeps(fakeProvider()));
    });
  });

  test("renewal sweep: one order and one reminder per period; skips cancelled, admin-managed and far-off periods", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const end = new Date(Date.now() + 2 * DAY);
      const sub = await mkSub(tx, user.id, { periodEnd: end });
      const deps = { prices: { pro: 19, elite: 49 }, currency: "USD" };

      expect(await runRenewalSweep(tx, deps, { userId: user.id })).toEqual({ created: 1 });
      expect(await runRenewalSweep(tx, deps, { userId: user.id })).toEqual({ created: 0 });
      const orders = await tx.select().from(paymentOrders).where(eq(paymentOrders.subscriptionId, sub.id));
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ merchantRef: renewalBaseRef(sub.id, end), purpose: "renewal", plan: "pro", amount: "19.00", currency: "USD", orderTrackingId: null });
      expect(await countNotifications(tx, user.id, "Renew your Pro plan")).toBe(1);

      // the user then presses "Renew": the SAME row is submitted, not a second one
      const p = fakeProvider();
      const co = await checkoutForUser(tx, { userId: user.id, plan: "pro" }, mkDeps(p));
      expect(co.orderId).toBe(orders[0].id);
      expect(p.submitted).toHaveLength(1);
      expect(p.submitted[0].merchantRef).toBe(orders[0].merchantRef);

      // not due / cancelled / admin-managed: nothing happens
      await tx.update(subscriptions).set({ periodEnd: new Date(Date.now() + 10 * DAY) }).where(eq(subscriptions.id, sub.id));
      expect((await runRenewalSweep(tx, deps, { userId: user.id })).created).toBe(0);
      await tx.update(subscriptions).set({ periodEnd: new Date(Date.now() + 1 * DAY), cancelAtPeriodEnd: true }).where(eq(subscriptions.id, sub.id));
      expect((await runRenewalSweep(tx, deps, { userId: user.id })).created).toBe(0);
      await tx.update(subscriptions).set({ cancelAtPeriodEnd: false }).where(eq(subscriptions.id, sub.id));
      await tx.update(users).set({ planSource: "admin" }).where(eq(users.id, user.id));
      expect((await runRenewalSweep(tx, deps, { userId: user.id })).created).toBe(0);
    });
  });

  test("renewal sweep: a run where every order already exists costs a constant number of statements, however many subscriptions", async () => {
    const deps = { prices: { pro: 19, elite: 49 }, currency: "USD" };
    const run = async (n: number) =>
      inRolledBackTx(async ({ tx, user, makeUser }) => {
        const people = [user, ...(await Promise.all(Array.from({ length: n - 1 }, () => makeUser())))];
        const ids = people.map((u) => u.id);
        const subs: Awaited<ReturnType<typeof mkSub>>[] = [];
        for (const u of people) {
          await resetUser(tx, u.id, "pro", "subscription");
          subs.push(await mkSub(tx, u.id, { periodEnd: new Date(Date.now() + 2 * DAY) }));
        }
        const first = await countQueries(() => runRenewalSweep(tx, deps, { userIds: ids }));
        const second = await countQueries(() => runRenewalSweep(tx, deps, { userIds: ids }));
        const orders = await tx.select().from(paymentOrders).where(inArray(paymentOrders.userId, ids));
        const reminders = await tx.select().from(notifications).where(and(inArray(notifications.userId, ids), eq(notifications.title, "Renew your Pro plan")));
        return { first, second, orders, reminders, subs };
      });

    const one = await run(1);
    const six = await run(6);

    for (const [n, r] of [[1, one], [6, six]] as const) {
      expect(r.first.result).toEqual({ created: n }); // every subscription gets exactly one order ...
      expect(r.orders).toHaveLength(n);
      expect(new Set(r.orders.map((o) => o.merchantRef)).size).toBe(n);
      for (const sub of r.subs) expect(r.orders.filter((o) => o.merchantRef === renewalBaseRef(sub.id, sub.periodEnd as Date))).toHaveLength(1);
      expect(r.reminders).toHaveLength(n); // ... and exactly one reminder
      expect(r.second.result).toEqual({ created: 0 }); // the second run creates nothing and sends nothing more
    }
    expect(six.second.queries).toBe(one.second.queries); // does not grow with the number of subscriptions
    expect(six.second.queries).toBe(2); // the candidate select + one lookup of the existing references
  });

  test("renewal sweep: only subscriptions without an order for this period get one (mixed batch)", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const deps = { prices: { pro: 19, elite: 49 }, currency: "USD" };
      const people = [user, await makeUser(), await makeUser()];
      const subs: Awaited<ReturnType<typeof mkSub>>[] = [];
      for (const u of people) {
        await resetUser(tx, u.id, "pro", "subscription");
        subs.push(await mkSub(tx, u.id, { periodEnd: new Date(Date.now() + 2 * DAY) }));
      }
      const ids = people.map((u) => u.id);
      // The middle subscription already has its order (as if an earlier run, or a retried checkout, created it).
      await runRenewalSweep(tx, deps, { userIds: [people[1].id] });
      const [existing] = await tx.select().from(paymentOrders).where(eq(paymentOrders.subscriptionId, subs[1].id));
      expect(existing.merchantRef).toBe(renewalBaseRef(subs[1].id, subs[1].periodEnd as Date));

      expect(await runRenewalSweep(tx, deps, { userIds: ids })).toEqual({ created: 2 });
      const orders = await tx.select().from(paymentOrders).where(inArray(paymentOrders.userId, ids));
      expect(orders).toHaveLength(3);
      expect(orders.find((o) => o.subscriptionId === subs[1].id)?.id).toBe(existing.id); // untouched
      for (const u of people) expect(await countNotifications(tx, u.id, "Renew your Pro plan")).toBe(1);
      // an empty id list selects nothing (and must not error)
      expect(await runRenewalSweep(tx, deps, { userIds: [] })).toEqual({ created: 0 });
    });
  });

  test("reconcile: a lost IPN is recovered by polling; fresh and long-dead orders are handled", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p = fakeProvider();
      const deps = mkDeps(p);
      const co = await createCheckout(tx, { userId: user.id, plan: "pro", purpose: "initial" }, deps);
      const order = await getOrder(tx, co.orderId);
      const tracking = order.orderTrackingId as string;
      p.statuses.set(tracking, completed(order));

      // 1 minute old: too fresh to poll
      let r = await runReconcileSweep(tx, { provider: p }, { userId: user.id });
      expect(r.polled).toBe(0);

      await tx.update(paymentOrders).set({ updatedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(paymentOrders.id, order.id));
      r = await runReconcileSweep(tx, { provider: p }, { userId: user.id });
      expect(r).toMatchObject({ polled: 1, applied: 1, errors: 0 });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
      r = await runReconcileSweep(tx, { provider: p }, { userId: user.id });
      expect(r.polled).toBe(0); // applied orders are never polled again
    });
  });

  test("reconcile: provider errors don't starve other orders, and 3-day-old unpaid orders are abandoned", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p = fakeProvider();
      const mk = async (i: number) => {
        const [o] = await tx
          .insert(paymentOrders)
          .values({ userId: user.id, merchantRef: `in_test_${randomUUID().slice(0, 8)}_${i}`, orderTrackingId: randomUUID(), purpose: "initial", plan: "pro", amount: "19.00", currency: "USD", updatedAt: new Date(Date.now() - 30 * 60_000) })
          .returning();
        return o;
      };
      const broken = await mk(1);
      const good = await mk(2);
      const ancient = await mk(3);
      await tx.update(paymentOrders).set({ createdAt: new Date(Date.now() - 4 * DAY) }).where(eq(paymentOrders.id, ancient.id));
      p.statuses.set(good.orderTrackingId as string, completed(good, { statusCode: 0 }));
      // `broken` has no scripted status -> the fake provider throws
      const r = await runReconcileSweep(tx, { provider: p }, { userId: user.id });
      expect(r).toMatchObject({ polled: 2, errors: 1, abandoned: 1 });
      expect((await getOrder(tx, ancient.id)).statusText).toBe("ABANDONED");
      // both polled orders were touched, so the next batch rotates to others
      expect((await getOrder(tx, broken.id)).updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect((await getOrder(tx, good.id)).updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });
  });
});

describe("changePlan", () => {
  test("upgrade: prorated order for the remaining period; payment moves the plan and keeps the period", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const now = new Date();
      const end = new Date(now.getTime() + 15 * DAY);
      const sub = await mkSub(tx, user.id, { periodEnd: end });
      const p = fakeProvider();
      const deps = mkDeps(p, { now: () => now });

      const r = await changePlan(tx, { userId: user.id, plan: "elite" }, deps);
      expect(r.outcome).toBe("checkout");
      expect(p.submitted).toHaveLength(1);
      expect(p.submitted[0].amount).toBe(15); // (49 - 19) * 15/30
      const order = await getOrder(tx, (r as { orderId: string }).orderId);
      expect(order).toMatchObject({ purpose: "upgrade", plan: "elite", amount: "15.00" });
      expect(parseUpgradeAnchor(order.merchantRef)).toBe(Math.floor(end.getTime() / 1000));
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro" }); // nothing yet

      // clicking again re-uses the open checkout
      const again = await changePlan(tx, { userId: user.id, plan: "elite" }, deps);
      expect(again).toMatchObject({ outcome: "checkout", orderId: order.id });
      expect(p.submitted).toHaveLength(1);

      expect((await applyVerifiedPayment(tx, order.id, completed(order), { now })).outcome).toBe("applied");
      const upgraded = await getSub(tx, sub.id);
      expect(upgraded.plan).toBe("elite");
      expect(upgraded.periodEnd?.getTime()).toBe(end.getTime()); // no extension: the difference only covers what's left
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "elite", planSource: "subscription" });
    });
  });

  test("an upgrade paid after the period moved on is not applied (needs a refund), never a free month", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const now = new Date();
      const end = new Date(now.getTime() + 20 * DAY);
      const sub = await mkSub(tx, user.id, { periodEnd: end });
      const p = fakeProvider();
      const r = await changePlan(tx, { userId: user.id, plan: "elite" }, mkDeps(p, { now: () => now }));
      const order = await getOrder(tx, (r as { orderId: string }).orderId);
      // meanwhile a renewal extended the period
      await tx.update(subscriptions).set({ periodEnd: new Date(end.getTime() + 30 * DAY) }).where(eq(subscriptions.id, sub.id));
      const out = await applyVerifiedPayment(tx, order.id, completed(order), { now });
      expect(out).toMatchObject({ outcome: "rejected", reason: "stale_upgrade" });
      expect((await getSub(tx, sub.id)).plan).toBe("pro");
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro" });
      const o = await getOrder(tx, order.id);
      expect(o.appliedAt).toBeNull();
      expect(o.statusText).toBe("STALE_UPGRADE");
    });
  });

  test("a negligible upgrade is scheduled for the next renewal instead of charged", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const sub = await mkSub(tx, user.id, { periodEnd: new Date(Date.now() + 2 * HOUR) });
      const p = fakeProvider();
      const r = await changePlan(tx, { userId: user.id, plan: "elite" }, mkDeps(p));
      expect(r).toMatchObject({ outcome: "scheduled", plan: "elite" });
      expect(p.submitted).toHaveLength(0);
      expect((await getSub(tx, sub.id)).pendingPlan).toBe("elite");
      // the next renewal is priced at Elite
      expect((await runRenewalSweep(tx, { prices: { pro: 19, elite: 49 }, currency: "USD" }, { userId: user.id })).created).toBe(1);
      const [o] = await tx.select().from(paymentOrders).where(eq(paymentOrders.subscriptionId, sub.id));
      expect(o).toMatchObject({ plan: "elite", amount: "49.00" });
    });
  });

  test("downgrade: scheduled for period end, no early renewal order, paid at the lower price once the period is over", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "elite", "subscription");
      const end = new Date(Date.now() + 2 * DAY);
      const sub = await mkSub(tx, user.id, { plan: "elite", periodEnd: end });
      const p = fakeProvider();
      const prices = { pro: 19, elite: 49 };

      const r = await changePlan(tx, { userId: user.id, plan: "pro" }, mkDeps(p));
      expect(r).toMatchObject({ outcome: "scheduled", plan: "pro" });
      expect(p.submitted).toHaveLength(0);
      expect(await getSub(tx, sub.id)).toMatchObject({ pendingPlan: "pro", plan: "elite", status: "active" });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "elite" }); // they keep what they paid for
      expect((await runRenewalSweep(tx, { prices, currency: "USD" }, { userId: user.id })).created).toBe(0);

      // period over -> past_due, then the renewal order appears at the Pro price
      const after = new Date(end.getTime() + HOUR);
      await runExpirySweep(tx, { now: after, userId: user.id });
      expect((await getSub(tx, sub.id)).status).toBe("past_due");
      expect((await runRenewalSweep(tx, { prices, currency: "USD", now: () => after }, { userId: user.id })).created).toBe(1);
      const co = await checkoutForUser(tx, { userId: user.id, plan: "pro" }, mkDeps(p, { now: () => after }));
      const order = await getOrder(tx, co.orderId);
      expect(order).toMatchObject({ plan: "pro", amount: "19.00", purpose: "renewal" });
      await applyVerifiedPayment(tx, order.id, completed(order), { now: after });
      expect(await getSub(tx, sub.id)).toMatchObject({ plan: "pro", pendingPlan: null, status: "active" });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
    });
  });

  test("'free' is a cancellation; picking the current plan clears a scheduled change", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "elite", "subscription");
      const end = new Date(Date.now() + 9 * DAY);
      const sub = await mkSub(tx, user.id, { plan: "elite", periodEnd: end, pendingPlan: "pro" });
      const p = fakeProvider();
      expect(await changePlan(tx, { userId: user.id, plan: "elite" }, mkDeps(p))).toMatchObject({ outcome: "scheduled" });
      expect((await getSub(tx, sub.id)).pendingPlan).toBeNull();
      expect(await changePlan(tx, { userId: user.id, plan: "elite" }, mkDeps(p))).toEqual({ outcome: "unchanged" });
      expect(await changePlan(tx, { userId: user.id, plan: "free" }, mkDeps(p))).toMatchObject({ outcome: "scheduled", plan: "free" });
      expect(await getSub(tx, sub.id)).toMatchObject({ cancelAtPeriodEnd: true });
    });
  });

  test("a user with no subscription asking for a paid plan gets an initial checkout", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p = fakeProvider();
      expect((await changePlan(tx, { userId: user.id, plan: "pro" }, mkDeps(p))).outcome).toBe("checkout");
      expect(await changePlan(tx, { userId: user.id, plan: "free" }, mkDeps(p))).toEqual({ outcome: "unchanged" });
    });
  });
});

// ─── real concurrency: committed rows, deleted afterwards ────────────────────

describe("concurrency (committed rows, cleaned up)", () => {
  const startedAt = new Date();
  let userId = "";
  let saved: { exists: boolean; plan?: string; planSource?: string } = { exists: false };
  const createdSubs: string[] = [];
  const createdOrders: string[] = [];
  const trackingIds: string[] = [];

  async function freshUserState() {
    await db.delete(paymentOrders).where(or(inArray(paymentOrders.id, createdOrders), inArray(paymentOrders.subscriptionId, createdSubs)));
    if (createdSubs.length) await db.delete(subscriptions).where(inArray(subscriptions.id, createdSubs));
    createdOrders.length = 0;
    createdSubs.length = 0;
    // Put the shared test user back right away: other suites use the same account.
    await db.update(users).set({ plan: (saved.plan ?? "free") as "free", planSource: (saved.planSource ?? "default") as "default" }).where(eq(users.id, userId));
  }

  /** A test that commits rows: always cleans up in `finally`, so a failing assertion never leaks a plan. */
  function racing(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      await freshUserState();
      try {
        await fn();
      } finally {
        await freshUserState();
      }
    });
  }

  beforeAll(async () => {
    const rows = (await db.execute(sql`select id, email from auth.users order by created_at limit 1`)) as unknown as { id: string; email: string }[];
    userId = rows[0].id;
    const [existing] = await db.select().from(users).where(eq(users.id, userId));
    if (existing) saved = { exists: true, plan: existing.plan, planSource: existing.planSource };
    else await db.insert(users).values({ id: userId, email: rows[0].email });
    const live = await db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ["approval_pending", "active", "past_due"])));
    if (live.length) throw new Error("Refusing to run concurrency tests: the test user already has a live subscription");
  });

  afterAll(async () => {
    if (!userId) return;
    // Only rows this suite created (tracked ids); never "everything the user has".
    if (trackingIds.length) await db.delete(paymentEvents).where(inArray(paymentEvents.orderTrackingId, trackingIds));
    await db.delete(paymentOrders).where(or(inArray(paymentOrders.id, createdOrders), inArray(paymentOrders.subscriptionId, createdSubs)));
    if (createdSubs.length) await db.delete(subscriptions).where(inArray(subscriptions.id, createdSubs));
    await db
      .delete(notifications)
      .where(and(eq(notifications.userId, userId), gte(notifications.createdAt, startedAt), inArray(notifications.title, ["Payment received", "Renew your Pro plan", "Payment reversed"])));
    if (saved.exists) await db.update(users).set({ plan: saved.plan as "free", planSource: saved.planSource as "default" }).where(eq(users.id, userId));
    else await db.delete(users).where(eq(users.id, userId));
    void startedAt;
  });

  racing("a payment applied by 6 racing callers (callback + IPN + reconcile) extends the period exactly once", async () => {
    const [sub] = await db.insert(subscriptions).values({ userId, plan: "pro", status: "approval_pending" }).returning();
    createdSubs.push(sub.id);
    const tracking = randomUUID();
    trackingIds.push(tracking);
    const [order] = await db
      .insert(paymentOrders)
      .values({ userId, subscriptionId: sub.id, merchantRef: `in_race_${randomUUID().slice(0, 12)}`, orderTrackingId: tracking, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" })
      .returning();
    createdOrders.push(order.id);

    const results = await Promise.all(Array.from({ length: 6 }, () => applyVerifiedPayment(db, order.id, completed(order), { now: new Date() })));
    expect(results.filter((r) => r.outcome === "applied")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already_applied")).toHaveLength(5);

    const after = await getSub(db, sub.id);
    expect(after.status).toBe("active");
    expect((after.periodEnd as Date).getTime() - (after.periodStart as Date).getTime()).toBe(30 * DAY); // one extension, not six
    expect(await countNotifications(db, userId, "Payment received")).toBeGreaterThanOrEqual(1);
    const notes = (await db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.title, "Payment received")))).filter((n) => n.createdAt >= startedAt);
    expect(notes).toHaveLength(1);
    expect(await getUser(db, userId)).toMatchObject({ plan: "pro", planSource: "subscription" });
  });

  racing("two renewal payments racing on the same subscription both count (neither lost-update wins)", async () => {
    const end = new Date(Date.now() + 2 * DAY);
    const sub = await mkSub(db, userId, { periodEnd: end });
    createdSubs.push(sub.id);
    const mk = async () => {
      const t = randomUUID();
      trackingIds.push(t);
      const [o] = await db
        .insert(paymentOrders)
        .values({ userId, subscriptionId: sub.id, merchantRef: `rn_race_${randomUUID().slice(0, 12)}`, orderTrackingId: t, purpose: "renewal", plan: "pro", amount: "19.00", currency: "USD" })
        .returning();
      createdOrders.push(o.id);
      return o;
    };
    const [a, b] = [await mk(), await mk()];
    await Promise.all([applyVerifiedPayment(db, a.id, completed(a)), applyVerifiedPayment(db, b.id, completed(b))]);
    const after = await getSub(db, sub.id);
    expect(after.periodEnd?.getTime()).toBe(end.getTime() + 60 * DAY);
  });

  racing("two concurrent renewal sweeps create exactly one order and one reminder", async () => {
    const sub = await mkSub(db, userId, { periodEnd: new Date(Date.now() + 2 * DAY) });
    await db.update(users).set({ plan: "pro", planSource: "subscription" }).where(eq(users.id, userId));
    createdSubs.push(sub.id);
    const deps = { prices: { pro: 19, elite: 49 }, currency: "USD" };
    const results = await Promise.all([runRenewalSweep(db, deps, { userId }), runRenewalSweep(db, deps, { userId }), runRenewalSweep(db, deps, { userId })]);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(1);
    const orders = await db.select().from(paymentOrders).where(eq(paymentOrders.subscriptionId, sub.id));
    expect(orders).toHaveLength(1);
    const reminders = (await db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.title, "Renew your Pro plan")))).filter((n) => n.createdAt >= startedAt);
    expect(reminders).toHaveLength(1);
  });

  racing("a double-clicked checkout opens exactly one hosted order", async () => {
    const p = fakeProvider();
    p.submitDelayMs = 80;
    const deps = mkDeps(p);
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () => createCheckout(db, { userId, plan: "pro", purpose: "initial" }, deps)));
    const made = await db.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), gte(subscriptions.createdAt, startedAt)));
    createdSubs.push(...made.map((s) => s.id)); // tracked for cleanup before any assertion can fail
    expect(p.submitted).toHaveLength(1);
    const ok = settled.filter((s): s is PromiseFulfilledResult<{ orderId: string; redirectUrl: string }> => s.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((s) => s.value.orderId)).size).toBe(1);
    for (const s of settled) if (s.status === "rejected") expect(s.reason).toMatchObject({ code: "CONFLICT" });
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(subs).toHaveLength(1);
    expect(await db.select().from(paymentOrders).where(eq(paymentOrders.userId, userId))).toHaveLength(1);
  });
});
