/**
 * The reconcile sweep and the tick deadline (Q-5). Every test runs inside a rolled-back transaction on its own
 * synthetic user, and EVERY sweep call is restricted to that user (`userId`): this suite never polls or changes
 * an order it did not create. Pesapal is never contacted: a fake provider stands in, and the wall clock used for
 * the budget check is injected, so nothing here sleeps.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { paymentOrders } from "@/db/schema";
import { inRolledBackTx } from "@/server/testing";
import { RECONCILE_POLL_TIMEOUT_MS, runReconcileSweep } from "./core";
import { DAY, completed, fakeProvider, getOrder, resetUser } from "./testkit";

setDefaultTimeout(120_000);

/** An unpaid order with a tracking id that has been quiet long enough to be polled. */
async function dueOrder(tx: DbLike, userId: string, i: number, ageMs = 30 * 60_000) {
  const [o] = await tx
    .insert(paymentOrders)
    .values({ userId, merchantRef: `in_dl_${randomUUID().slice(0, 8)}_${i}`, orderTrackingId: randomUUID(), purpose: "initial", plan: "pro", amount: "19.00", currency: "USD", updatedAt: new Date(Date.now() - ageMs) })
    .returning();
  return o;
}

describe("reconcile sweep: honours the tick deadline", () => {
  test("a deadline in the past polls nothing and leaves the orders first in line; the bookkeeping still runs", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p = fakeProvider();
      const orders = [await dueOrder(tx, user.id, 1), await dueOrder(tx, user.id, 2)];
      const ancient = await dueOrder(tx, user.id, 3);
      await tx.update(paymentOrders).set({ createdAt: new Date(Date.now() - 4 * DAY) }).where(eq(paymentOrders.id, ancient.id));
      for (const o of orders) p.statuses.set(o.orderTrackingId as string, completed(o, { statusCode: 0 }));

      const r = await runReconcileSweep(tx, { provider: p }, { userId: user.id, deadline: Date.now() - 1 });
      expect(r).toMatchObject({ polled: 0, applied: 0, errors: 0, abandoned: 1 });
      expect(p.statusCalls).toEqual([]);
      for (const o of orders) expect((await getOrder(tx, o.id)).updatedAt.getTime()).toBe(o.updatedAt.getTime()); // not touched: still first in line

      // with a generous deadline the very same orders are polled as before
      const again = await runReconcileSweep(tx, { provider: p }, { userId: user.id, deadline: Date.now() + 10 * 60_000 });
      expect(again).toMatchObject({ polled: 2, errors: 0 });
      expect(p.statusCalls).toHaveLength(2);
    });
  });

  test("no deadline (a caller outside a tick) behaves exactly as before", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const p = fakeProvider();
      const orders = [await dueOrder(tx, user.id, 1), await dueOrder(tx, user.id, 2), await dueOrder(tx, user.id, 3)];
      for (const o of orders) p.statuses.set(o.orderTrackingId as string, completed(o, { statusCode: 0 }));
      expect(await runReconcileSweep(tx, { provider: p }, { userId: user.id })).toMatchObject({ polled: 3, errors: 0 });
    });
  });

  test("stops starting polls once less than one poll timeout is left (boundary and mid-run), using the injected clock", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      let clock = 1_000_000_000;
      const nowMs = () => clock;
      const p = fakeProvider();
      // every poll "takes" a full poll timeout of the (fake) wall clock
      const slow = { ...p, getStatus: async (id: string) => { clock += RECONCILE_POLL_TIMEOUT_MS; return p.getStatus(id); } };
      const orders = [await dueOrder(tx, user.id, 1), await dueOrder(tx, user.id, 2), await dueOrder(tx, user.id, 3)];
      for (const o of orders) p.statuses.set(o.orderTrackingId as string, completed(o, { statusCode: 0 }));
      const run = (deadline: number) => runReconcileSweep(tx, { provider: slow, nowMs }, { userId: user.id, deadline });

      // one millisecond short of one poll timeout left: nothing starts
      expect(await run(clock + RECONCILE_POLL_TIMEOUT_MS - 1)).toMatchObject({ polled: 0 });
      // exactly one poll timeout left: one poll starts, and then the budget is spent
      expect(await run(clock + RECONCILE_POLL_TIMEOUT_MS)).toMatchObject({ polled: 1 });
      expect(p.statusCalls).toHaveLength(1);
      // the two orders that were skipped kept their old updated_at, so they are still first in line ...
      const untouched = (await tx.select().from(paymentOrders).where(eq(paymentOrders.userId, user.id))).filter((o) => o.updatedAt.getTime() < Date.now() - 20 * 60_000);
      expect(untouched).toHaveLength(2);
      // ... and with room for two polls, exactly those two are polled
      expect(await run(clock + 2 * RECONCILE_POLL_TIMEOUT_MS)).toMatchObject({ polled: 2 });
      expect(p.statusCalls).toHaveLength(3);
    });
  });
});
