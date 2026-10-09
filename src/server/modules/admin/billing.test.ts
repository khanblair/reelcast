import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { paymentEvents, paymentOrders, subscriptions } from "@/db/schema";
import type { UserRow } from "../../rpc/define";
import { callRpc, inRolledBackTx } from "../../testing";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const asAdmin = (u: UserRow): UserRow => ({ ...u, isAdmin: true });

type Overview = {
  subscriptions: { active: number; pastDue: number; awaitingPayment: number; cancelled: number; expired: number };
  revenue30d: { currency: string; total: number; count: number }[];
  needsReviewCount: number;
  pendingPayments: number;
};
type Payment = {
  _id: string; email: string; amount: number; currency: string; statusCode?: number; statusText?: string;
  flag?: string; flagLabel?: string; guidance?: string; reviewedAt?: number; reviewNote?: string; confirmationCode?: string;
  redirectUrl?: unknown;
};

async function pay(tx: DbLike, userId: string, over: Partial<typeof paymentOrders.$inferInsert> = {}) {
  const [row] = await tx
    .insert(paymentOrders)
    .values({ userId, merchantRef: `t_${randomUUID()}`, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD", statusCode: 1, appliedAt: ago(1), ...over })
    .returning();
  return row;
}

describe("admin.billing.overview", () => {
  test("counts subscriptions by status and revenue only from applied payments in the last 30 days, per currency", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const before = (await callRpc("admin.billing.overview", {}, { user: admin, tx })) as Overview;

      const [a, b, c] = [await makeUser(), await makeUser(), await makeUser()];
      await tx.insert(subscriptions).values([
        { userId: a.id, plan: "pro", status: "active" },
        { userId: b.id, plan: "pro", status: "past_due" },
        { userId: c.id, plan: "pro", status: "approval_pending" },
      ]);
      await pay(tx, a.id, { amount: "19.00", currency: "USD", appliedAt: ago(2) }); // counts
      await pay(tx, a.id, { amount: "10.50", currency: "USD", appliedAt: ago(5) }); // counts
      await pay(tx, a.id, { amount: "500.00", currency: "KES", appliedAt: ago(3) }); // other currency
      await pay(tx, a.id, { amount: "99.00", currency: "USD", appliedAt: ago(40) }); // too old
      await pay(tx, a.id, { amount: "77.00", currency: "USD", statusCode: 2, appliedAt: null }); // failed
      await pay(tx, a.id, { amount: "66.00", currency: "USD", statusCode: 1, appliedAt: null }); // completed but never applied

      const after = (await callRpc("admin.billing.overview", {}, { user: admin, tx })) as Overview;
      expect(after.subscriptions.active - before.subscriptions.active).toBe(1);
      expect(after.subscriptions.pastDue - before.subscriptions.pastDue).toBe(1);
      expect(after.subscriptions.awaitingPayment - before.subscriptions.awaitingPayment).toBe(1);

      const usd = (o: Overview) => o.revenue30d.find((r) => r.currency === "USD") ?? { total: 0, count: 0 };
      const kes = (o: Overview) => o.revenue30d.find((r) => r.currency === "KES") ?? { total: 0, count: 0 };
      expect(usd(after).total - usd(before).total).toBeCloseTo(29.5, 5);
      expect(usd(after).count - usd(before).count).toBe(2);
      expect(kes(after).total - kes(before).total).toBeCloseTo(500, 5);
    });
  });

  test("needsReviewCount counts flagged, unreviewed payments only", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const u = await makeUser();
      const before = ((await callRpc("admin.billing.overview", {}, { user: admin, tx })) as Overview).needsReviewCount;
      await pay(tx, u.id, { statusText: "AMOUNT_MISMATCH", appliedAt: null });
      await pay(tx, u.id, { statusText: "STALE_UPGRADE", appliedAt: null });
      await pay(tx, u.id, { statusCode: 3, statusText: "REVERSED", appliedAt: null });
      await pay(tx, u.id, { statusText: "AMOUNT_MISMATCH", reviewedAt: new Date(), appliedAt: null }); // already reviewed
      await pay(tx, u.id); // ordinary payment
      const after = ((await callRpc("admin.billing.overview", {}, { user: admin, tx })) as Overview).needsReviewCount;
      expect(after - before).toBe(3);
    });
  });
});

describe("admin.billing.listSubscriptions", () => {
  test("filters by status and searches by email; totals match the filter", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const tag = randomUUID().slice(0, 8);
      const a = await makeUser({ email: `alice-${tag}@example.test` });
      const b = await makeUser({ email: `bob-${tag}@example.test` });
      await tx.insert(subscriptions).values([
        { userId: a.id, plan: "pro", status: "active", periodEnd: new Date(Date.now() + 10 * DAY) },
        { userId: b.id, plan: "elite", status: "past_due", graceUntil: new Date(Date.now() + DAY) },
      ]);

      const all = (await callRpc("admin.billing.listSubscriptions", { search: tag }, { user: admin, tx })) as { total: number; rows: { email: string; status: string; plan: string }[] };
      expect(all.total).toBe(2);
      expect(all.rows.map((r) => r.email).sort()).toEqual([`alice-${tag}@example.test`, `bob-${tag}@example.test`]);

      const pastDue = (await callRpc("admin.billing.listSubscriptions", { search: tag, status: "past_due" }, { user: admin, tx })) as { total: number; rows: { email: string; plan: string }[] };
      expect(pastDue.total).toBe(1);
      expect(pastDue.rows[0]).toMatchObject({ email: `bob-${tag}@example.test`, plan: "elite" });

      const none = (await callRpc("admin.billing.listSubscriptions", { search: "no-such-customer-xyz" }, { user: admin, tx })) as { total: number; rows: unknown[] };
      expect(none).toEqual({ total: 0, rows: [] });
    });
  });

  test("a search containing LIKE wildcards matches literally", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const u = await makeUser({ email: `wild_${randomUUID().slice(0, 6)}@example.test` });
      await tx.insert(subscriptions).values({ userId: u.id, plan: "pro", status: "active" });
      const r = (await callRpc("admin.billing.listSubscriptions", { search: "%" }, { user: admin, tx })) as { total: number };
      expect(r.total).toBe(0); // a bare % must not match everything
    });
  });

  test("paging respects limit and offset", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const tag = randomUUID().slice(0, 8);
      for (let i = 0; i < 3; i++) {
        const u = await makeUser({ email: `page${i}-${tag}@example.test` });
        await tx.insert(subscriptions).values({ userId: u.id, plan: "pro", status: "expired" });
      }
      const p1 = (await callRpc("admin.billing.listSubscriptions", { search: tag, limit: 2, offset: 0 }, { user: admin, tx })) as { total: number; rows: unknown[] };
      const p2 = (await callRpc("admin.billing.listSubscriptions", { search: tag, limit: 2, offset: 2 }, { user: admin, tx })) as { total: number; rows: unknown[] };
      expect([p1.total, p1.rows.length, p2.total, p2.rows.length]).toEqual([3, 2, 3, 1]);
    });
  });
});

describe("admin.billing.listPayments", () => {
  test("filters by outcome, shows numeric amounts, and labels flagged payments", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const tag = randomUUID().slice(0, 8);
      const u = await makeUser({ email: `pay-${tag}@example.test` });
      await pay(tx, u.id, { amount: "19.00" });
      await pay(tx, u.id, { statusCode: null, appliedAt: null, orderTrackingId: `trk-${tag}-1` });
      await pay(tx, u.id, { statusCode: 2, appliedAt: null });
      await pay(tx, u.id, { statusCode: 3, statusText: "REVERSED", appliedAt: null });
      await pay(tx, u.id, { statusText: "AMOUNT_MISMATCH", amount: "12.34", appliedAt: null });

      const list = async (filter: string) =>
        (await callRpc("admin.billing.listPayments", { filter, search: tag }, { user: admin, tx })) as { total: number; rows: Payment[] };

      expect((await list("all")).total).toBe(5);
      expect((await list("completed")).total).toBe(2); // the ordinary one + the mismatch (Pesapal said completed)
      expect((await list("pending")).total).toBe(1);
      expect((await list("failed")).total).toBe(1);
      expect((await list("reversed")).total).toBe(1);

      const mismatch = (await list("all")).rows.find((r) => r.statusText === "AMOUNT_MISMATCH")!;
      expect(mismatch.amount).toBe(12.34); // numeric, not a string
      expect(mismatch.flag).toBe("amount_mismatch");
      expect(mismatch.flagLabel).toBe("Amount mismatch");
      expect(mismatch.guidance).toContain("Pesapal");
      const reversed = (await list("reversed")).rows[0];
      expect(reversed.flag).toBe("reversed");
    });
  });

  test("never exposes checkout links", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const u = await makeUser();
      const p = await pay(tx, u.id, { redirectUrl: "https://pay.example/checkout/secret-token" });
      const r = (await callRpc("admin.billing.listPayments", { search: u.email }, { user: asAdmin(user), tx })) as { rows: Payment[] };
      const row = r.rows.find((x) => x._id === p.id)!;
      expect(row.redirectUrl).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain("secret-token");
    });
  });
});

describe("admin.billing.listNeedsReview and markReviewed", () => {
  test("lists the three kinds of flagged payment, hides reviewed ones unless asked", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const tag = randomUUID().slice(0, 8);
      const u = await makeUser({ email: `rev-${tag}@example.test` });
      const m = await pay(tx, u.id, { statusText: "AMOUNT_MISMATCH", appliedAt: null });
      await pay(tx, u.id, { statusText: "STALE_UPGRADE", purpose: "upgrade", appliedAt: null });
      await pay(tx, u.id, { statusCode: 3, statusText: "REVERSED", appliedAt: null });
      await pay(tx, u.id); // fine

      const queue = async (includeReviewed = false) =>
        ((await callRpc("admin.billing.listNeedsReview", { includeReviewed }, { user: admin, tx })) as { total: number; rows: Payment[] }).rows.filter((r) => r.email === `rev-${tag}@example.test`);

      expect((await queue()).map((r) => r.flag).sort()).toEqual(["amount_mismatch", "reversed", "stale_upgrade"]);

      await callRpc("admin.billing.markReviewed", { id: m.id, note: "Refunded in Pesapal" }, { user: admin, tx });
      expect((await queue()).length).toBe(2);
      const withReviewed = await queue(true);
      expect(withReviewed.length).toBe(3);
      const reviewed = withReviewed.find((r) => r._id === m.id)!;
      expect(reviewed.reviewedAt).toBeGreaterThan(0);
      expect(reviewed.reviewNote).toBe("Refunded in Pesapal");
    });
  });

  test("markReviewed records who and when, and a second call is a CONFLICT that changes nothing", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const u = await makeUser();
      const p = await pay(tx, u.id, { statusText: "STALE_UPGRADE", appliedAt: null });
      await callRpc("admin.billing.markReviewed", { id: p.id, note: "first" }, { user: admin, tx });
      const [after1] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, p.id));
      expect(after1.reviewedBy).toBe(admin.id);
      expect(after1.reviewNote).toBe("first");
      const firstAt = after1.reviewedAt!.getTime();

      await expect(callRpc("admin.billing.markReviewed", { id: p.id, note: "second" }, { user: admin, tx })).rejects.toMatchObject({ code: "CONFLICT" });
      const [after2] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, p.id));
      expect(after2.reviewNote).toBe("first");
      expect(after2.reviewedAt!.getTime()).toBe(firstAt);
    });
  });

  test("an ordinary payment or an unknown id is NOT_FOUND; the note is length-limited", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const u = await makeUser();
      const ok = await pay(tx, u.id);
      await expect(callRpc("admin.billing.markReviewed", { id: ok.id }, { user: admin, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("admin.billing.markReviewed", { id: randomUUID() }, { user: admin, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const flagged = await pay(tx, u.id, { statusText: "AMOUNT_MISMATCH", appliedAt: null });
      await expect(callRpc("admin.billing.markReviewed", { id: flagged.id, note: "x".repeat(501) }, { user: admin, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const [still] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, flagged.id));
      expect(still.reviewedAt).toBeNull();
    });
  });
});

describe("admin.billing.getPayment and forUser", () => {
  test("getPayment returns the notification trail without raw payloads", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const u = await makeUser();
      const tracking = `trk-${randomUUID().slice(0, 8)}`;
      const p = await pay(tx, u.id, { orderTrackingId: tracking, confirmationCode: "CONF123" });
      await tx.insert(paymentEvents).values([
        { orderTrackingId: tracking, merchantRef: p.merchantRef, notificationType: "IPNCHANGE", payload: { secret: "raw-body" }, processedAt: new Date() },
        { orderTrackingId: tracking, notificationType: "CALLBACKURL", payload: { x: 1 }, error: "boom" },
        { orderTrackingId: "someone-else", notificationType: "IPNCHANGE", payload: {} },
      ]);
      const r = (await callRpc("admin.billing.getPayment", { id: p.id }, { user: admin, tx })) as { payment: Payment; events: { notificationType: string; error?: string }[] };
      expect(r.payment.confirmationCode).toBe("CONF123");
      expect(r.events.length).toBe(2);
      expect(r.events.map((e) => e.notificationType).sort()).toEqual(["CALLBACKURL", "IPNCHANGE"]);
      expect(JSON.stringify(r)).not.toContain("raw-body");
      await expect(callRpc("admin.billing.getPayment", { id: randomUUID() }, { user: admin, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  test("forUser returns only that user's subscriptions and payments", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const [a, b] = [await makeUser(), await makeUser()];
      await tx.insert(subscriptions).values([{ userId: a.id, plan: "pro", status: "active" }, { userId: b.id, plan: "elite", status: "active" }]);
      const pa = await pay(tx, a.id);
      await pay(tx, b.id);
      const r = (await callRpc("admin.billing.forUser", { userId: a.id }, { user: admin, tx })) as { subscriptions: { plan: string }[]; payments: Payment[] };
      expect(r.subscriptions.map((s) => s.plan)).toEqual(["pro"]);
      expect(r.payments.map((p) => p._id)).toEqual([pa.id]);
    });
  });
});

describe("admin.billing is admin-only", () => {
  test("signed-out callers are UNAUTHENTICATED and non-admins FORBIDDEN on every function", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const calls: [string, Record<string, unknown>][] = [
        ["admin.billing.overview", {}],
        ["admin.billing.listSubscriptions", {}],
        ["admin.billing.listPayments", {}],
        ["admin.billing.listNeedsReview", {}],
        ["admin.billing.getPayment", { id: randomUUID() }],
        ["admin.billing.markReviewed", { id: randomUUID() }],
        ["admin.billing.forUser", { userId: randomUUID() }],
      ];
      for (const [path, args] of calls) {
        await expect(callRpc(path, args, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
        await expect(callRpc(path, args, { user: { ...user, isAdmin: false }, tx })).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    });
  });
});
