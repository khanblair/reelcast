/**
 * The payment-events retention purge. Rolled-back transactions only, and every call names the ids of the events the test
 * created (`eventIds`, the test seam), so it never reads, locks or deletes a real event of the shared database.
 * `now` is a fixed Date handed to the function and every row is seeded relative to it.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { paymentEvents, paymentOrders } from "@/db/schema";
import { countQueries, inRolledBackTx } from "@/server/testing";
import { PAYMENT_EVENT_PURGE_BATCH, PAYMENT_EVENT_PURGE_WINDOW_MS, PAYMENT_EVENT_RETENTION_MS, purgeUnmatchedEvents } from "./core";
import { DAY, HOUR } from "./testkit";

setDefaultTimeout(120_000);

const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);

/** An order owning a tracking id and a merchant reference; events can match it by either. */
async function mkOrder(tx: DbLike, userId: string) {
  const o = { tracking: `__purge_trk_${randomUUID()}`, ref: `__purge_ref_${randomUUID().slice(0, 16)}` };
  await tx.insert(paymentOrders).values({ userId, merchantRef: o.ref, orderTrackingId: o.tracking, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" });
  return o;
}

type Ev = { tracking?: string | null; ref?: string | null; age: number };
async function mkEvent(tx: DbLike, e: Ev) {
  const [row] = await tx
    .insert(paymentEvents)
    .values({
      orderTrackingId: e.tracking === undefined ? `__purge_unmatched_${randomUUID()}` : e.tracking,
      merchantRef: e.ref ?? null,
      notificationType: "IPN",
      payload: {},
      receivedAt: ago(e.age),
    })
    .returning({ id: paymentEvents.id });
  return row.id;
}

const present = async (tx: DbLike, ids: string[]) =>
  new Set((await tx.select({ id: paymentEvents.id }).from(paymentEvents).where(inArray(paymentEvents.id, ids))).map((r) => r.id));

/** Ages relative to the 30-day retention cutoff. */
const RETAIN = PAYMENT_EVENT_RETENTION_MS;
const inWindow = RETAIN + 12 * HOUR; // turned 30 days old 12 hours ago
const beyondWindow = RETAIN + PAYMENT_EVENT_PURGE_WINDOW_MS + 12 * HOUR; // turned 30 days old 36 hours ago
const young = 10 * DAY;

describe("purgeUnmatchedEvents", () => {
  test("the frequent run deletes unmatched events that just turned 30 days old and nothing else", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await mkOrder(tx, user.id);
      const gone = await mkEvent(tx, { age: inWindow });
      const goneNoIds = await mkEvent(tx, { tracking: null, age: inWindow }); // an unparsed request: no ids at all
      const beyond = await mkEvent(tx, { age: beyondWindow });
      const fresh = await mkEvent(tx, { age: young });
      const edgeYoung = await mkEvent(tx, { age: RETAIN - HOUR }); // 29d23h: not yet eligible
      const matchedTracking = await mkEvent(tx, { tracking: order.tracking, age: inWindow });
      const matchedRef = await mkEvent(tx, { tracking: null, ref: order.ref, age: inWindow });
      const matchedOld = await mkEvent(tx, { tracking: order.tracking, age: 400 * DAY });
      const ids = [gone, goneNoIds, beyond, fresh, edgeYoung, matchedTracking, matchedRef, matchedOld];

      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids })).toBe(2);
      expect(await present(tx, ids)).toEqual(new Set([beyond, fresh, edgeYoung, matchedTracking, matchedRef, matchedOld]));
    });
  });

  test("it does not look behind the window (an unmatched event 36 hours past its cutoff survives it); the catch-up run removes it", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await mkOrder(tx, user.id);
      const beyond = await mkEvent(tx, { age: beyondWindow });
      const ancient = await mkEvent(tx, { age: 200 * DAY });
      const matchedAncient = await mkEvent(tx, { tracking: order.tracking, ref: order.ref, age: 200 * DAY });
      const ids = [beyond, ancient, matchedAncient];

      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids })).toBe(0);
      expect(await present(tx, ids)).toEqual(new Set(ids));

      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids, catchUp: true })).toBe(2);
      expect(await present(tx, ids)).toEqual(new Set([matchedAncient])); // matched events stay for the audit, however old
    });
  });

  test("the catch-up run deletes exactly the set the original, unbounded statement deleted", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await mkOrder(tx, user.id);
      const ages = [young, RETAIN - 1_000, RETAIN + 1_000, inWindow, beyondWindow, 90 * DAY, 400 * DAY];
      const ids: string[] = [];
      for (const age of ages) {
        ids.push(await mkEvent(tx, { age }));
        ids.push(await mkEvent(tx, { tracking: order.tracking, age }));
        ids.push(await mkEvent(tx, { tracking: `__purge_other_${randomUUID()}`, ref: order.ref, age })); // matched by reference only
        ids.push(await mkEvent(tx, { tracking: null, age }));
      }
      // The original statement's condition, verbatim, as a SELECT over the same rows.
      const cutoff = ago(RETAIN).toISOString();
      const expected = (await tx.execute(sql`
        select e.id from payment_events e
        where e.received_at < ${cutoff}::timestamptz
          and not exists (select 1 from payment_orders o where o.order_tracking_id = e.order_tracking_id or o.merchant_ref = e.merchant_ref)
          and e.id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
      `)) as unknown as { id: string }[];
      expect(expected.length).toBe(10); // 5 eligible ages x the 2 unmatched kinds (a random id, and no ids at all)

      const deleted = await purgeUnmatchedEvents(tx, now, { eventIds: ids, catchUp: true });
      expect(deleted).toBe(expected.length);
      const left = await present(tx, ids);
      expect(ids.filter((i) => !left.has(i)).sort()).toEqual(expected.map((r) => r.id).sort());
    });
  });

  test("a second run changes nothing", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const a = await mkEvent(tx, { age: inWindow });
      const b = await mkEvent(tx, { age: inWindow });
      const ids = [a, b];
      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids })).toBe(2);
      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids })).toBe(0);
      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids, catchUp: true })).toBe(0);
    });
  });

  test("one run deletes at most `limit` rows; the next runs take the rest", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push(await mkEvent(tx, { age: inWindow }));
      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids, limit: 5 })).toBe(5);
      expect((await present(tx, ids)).size).toBe(3);
      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids, limit: 5 })).toBe(3);
      expect((await present(tx, ids)).size).toBe(0);
      expect(await purgeUnmatchedEvents(tx, now, { eventIds: ids, limit: 5 })).toBe(0);
    });
    expect(PAYMENT_EVENT_PURGE_BATCH).toBe(2_000); // the production batch
  });

  test("it is one statement whatever the number of rows", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const first = await mkEvent(tx, { age: inWindow });
      expect((await countQueries(() => purgeUnmatchedEvents(tx, now, { eventIds: [first] }))).queries).toBe(1);
      const many: string[] = [];
      for (let i = 0; i < 12; i++) many.push(await mkEvent(tx, { age: inWindow }));
      const busy = await countQueries(() => purgeUnmatchedEvents(tx, now, { eventIds: many }));
      expect(busy.result).toBe(12);
      expect(busy.queries).toBe(1);
      expect((await countQueries(() => purgeUnmatchedEvents(tx, now, { eventIds: many, catchUp: true }))).queries).toBe(1); // idle
    });
  });

  test("the test seam is strict: a scope, once given, may not be empty, and the limit must be positive", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await expect(purgeUnmatchedEvents(tx, now, { eventIds: [] })).rejects.toThrow("non-empty");
      await expect(purgeUnmatchedEvents(tx, now, { eventIds: [""] })).rejects.toThrow("non-empty");
      await expect(purgeUnmatchedEvents(tx, now, { eventIds: [randomUUID()], limit: 0 })).rejects.toThrow("positive integer");
    });
  });
});
