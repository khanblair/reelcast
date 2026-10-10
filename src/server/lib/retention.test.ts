/**
 * Retention sweep. Rolled-back transactions only, and every call names the ids of the rows the test created
 * (`scope`, the test seam), so nothing here reads, locks or deletes a real row of the shared database (`tasks` and
 * `notifications` hold real work). `now` is a fixed Date handed to the functions and every row is seeded relative to it.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { notifications, paymentEvents, paymentOrders, tasks, youtubeQuotaUsage } from "@/db/schema";
import { countQueries, inRolledBackTx } from "@/server/testing";
import {
  RETENTION_BATCH,
  purgeOldQuotaUsage,
  purgeOldTasks,
  purgeReadNotifications,
  runRetention,
  type RetentionScope,
} from "./retention";
import { utcDateString } from "./youtubeQuota";

setDefaultTimeout(120_000);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);

type TaskStatus = (typeof tasks.$inferInsert)["status"];
async function mkTask(tx: DbLike, status: TaskStatus, age: number, userId: string | null = null) {
  const [row] = await tx
    .insert(tasks)
    .values({ kind: `__retention_test_${randomUUID()}`, status, userId, updatedAt: ago(age), createdAt: ago(age), dedupeKey: null })
    .returning({ id: tasks.id });
  return row.id;
}

async function mkNote(tx: DbLike, userId: string, isRead: boolean, age: number) {
  const [row] = await tx.insert(notifications).values({ userId, title: "__retention_test", message: "x", type: "info", isRead, createdAt: ago(age) }).returning({ id: notifications.id });
  return row.id;
}

async function mkQuota(tx: DbLike, userId: string, daysBack: number) {
  const [row] = await tx
    .insert(youtubeQuotaUsage)
    .values({ userId, date: utcDateString(ago(daysBack * DAY)), unitsUsed: 10 })
    .returning({ id: youtubeQuotaUsage.id });
  return row.id;
}

const alive = async (tx: DbLike, table: "tasks" | "notifications" | "quota" | "events", ids: string[]) => {
  const t = { tasks, notifications, quota: youtubeQuotaUsage, events: paymentEvents }[table];
  return new Set((await tx.select({ id: t.id }).from(t).where(inArray(t.id, ids))).map((r) => r.id));
};

describe("purgeOldTasks", () => {
  test("deletes finished tasks older than 14 days; keeps young ones and anything pending or running, however old", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const old = 14 * DAY + HOUR;
      const gone = [
        await mkTask(tx, "done", old, user.id),
        await mkTask(tx, "failed", old, user.id),
        await mkTask(tx, "cancelled", old, user.id),
        await mkTask(tx, "done", 100 * DAY, null), // system tasks carry no user (digest, analytics)
        await mkTask(tx, "failed", old, other.id), // another user's rows are judged by the same rules
      ];
      const kept = [
        await mkTask(tx, "done", 14 * DAY - HOUR, user.id), // the boundary is 14 days
        await mkTask(tx, "failed", 1 * DAY, user.id),
        await mkTask(tx, "cancelled", 0, null),
        await mkTask(tx, "pending", 200 * DAY, user.id), // a stuck pending task is somebody's problem, never retention's
        await mkTask(tx, "running", 200 * DAY, other.id),
        await mkTask(tx, "pending", old, null),
      ];
      const ids = [...gone, ...kept];

      expect(await purgeOldTasks(tx, now, { ids })).toBe(gone.length);
      expect(await alive(tx, "tasks", ids)).toEqual(new Set(kept));
    });
  });

  test("a second run is a no-op", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ids = [await mkTask(tx, "done", 30 * DAY, user.id), await mkTask(tx, "failed", 30 * DAY, user.id)];
      expect(await purgeOldTasks(tx, now, { ids })).toBe(2);
      expect(await purgeOldTasks(tx, now, { ids })).toBe(0);
    });
  });
});

describe("purgeReadNotifications", () => {
  test("deletes READ notifications older than 90 days; unread ones and younger ones stay", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const gone = [await mkNote(tx, user.id, true, 90 * DAY + HOUR), await mkNote(tx, user.id, true, 400 * DAY), await mkNote(tx, other.id, true, 91 * DAY)];
      const kept = [
        await mkNote(tx, user.id, false, 400 * DAY), // never read: the user may still want it
        await mkNote(tx, other.id, false, 91 * DAY),
        await mkNote(tx, user.id, true, 90 * DAY - HOUR),
        await mkNote(tx, user.id, true, 1 * DAY),
        await mkNote(tx, user.id, false, 0),
      ];
      const ids = [...gone, ...kept];
      expect(await purgeReadNotifications(tx, now, { ids })).toBe(gone.length);
      expect(await alive(tx, "notifications", ids)).toEqual(new Set(kept));
      expect(await purgeReadNotifications(tx, now, { ids })).toBe(0);
    });
  });
});

describe("purgeOldQuotaUsage", () => {
  test("deletes counters for UTC days more than 90 days back; the last 90 days (and today) stay", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const gone = [await mkQuota(tx, user.id, 91), await mkQuota(tx, user.id, 400), await mkQuota(tx, other.id, 120)];
      const kept = [await mkQuota(tx, user.id, 90), await mkQuota(tx, user.id, 89), await mkQuota(tx, user.id, 1), await mkQuota(tx, user.id, 0), await mkQuota(tx, other.id, 5)];
      const ids = [...gone, ...kept];
      expect(await purgeOldQuotaUsage(tx, now, { ids })).toBe(gone.length);
      expect(await alive(tx, "quota", ids)).toEqual(new Set(kept));
      expect(await purgeOldQuotaUsage(tx, now, { ids })).toBe(0);
    });
  });
});

describe("runRetention", () => {
  /** Rows of every table, `n` of them eligible, plus one of each that must stay. */
  let nextDay = 100; // a user has one quota row per day, so every seeded row takes a day of its own
  async function seed(tx: DbLike, userId: string, n: number) {
    const gone = { taskIds: [] as string[], notificationIds: [] as string[], quotaUsageIds: [] as string[], eventIds: [] as string[] };
    for (let i = 0; i < n; i++) {
      gone.taskIds.push(await mkTask(tx, "done", 30 * DAY, userId));
      gone.notificationIds.push(await mkNote(tx, userId, true, 120 * DAY));
      gone.quotaUsageIds.push(await mkQuota(tx, userId, nextDay++));
      const [e] = await tx
        .insert(paymentEvents)
        .values({ orderTrackingId: `__retention_unmatched_${randomUUID()}`, notificationType: "IPN", payload: {}, receivedAt: ago(200 * DAY) })
        .returning({ id: paymentEvents.id });
      gone.eventIds.push(e.id);
    }
    return gone;
  }
  const scopeOf = (a: Awaited<ReturnType<typeof seed>>): RetentionScope => a;

  test("deletes from all four tables, keeps the audit trail, and a second run is a no-op", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const gone = await seed(tx, user.id, 3);
      // The billing audit trail must survive: an order with its events, however old.
      const trk = `__retention_trk_${randomUUID()}`;
      await tx.insert(paymentOrders).values({ userId: user.id, merchantRef: `__retention_ref_${randomUUID().slice(0, 12)}`, orderTrackingId: trk, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" });
      const [matched] = await tx.insert(paymentEvents).values({ orderTrackingId: trk, notificationType: "IPN", payload: {}, receivedAt: ago(700 * DAY) }).returning({ id: paymentEvents.id });
      const keptTask = await mkTask(tx, "pending", 300 * DAY, user.id);
      const keptNote = await mkNote(tx, user.id, false, 300 * DAY);
      const keptQuota = await mkQuota(tx, user.id, 0);
      const scope: RetentionScope = {
        taskIds: [...gone.taskIds, keptTask],
        notificationIds: [...gone.notificationIds, keptNote],
        quotaUsageIds: [...gone.quotaUsageIds, keptQuota],
        eventIds: [...gone.eventIds, matched.id],
      };

      expect(await runRetention(tx, now, { scope })).toEqual({ tasks: 3, notifications: 3, quotaUsage: 3, paymentEvents: 3 });
      expect(await alive(tx, "tasks", scope.taskIds!)).toEqual(new Set([keptTask]));
      expect(await alive(tx, "notifications", scope.notificationIds!)).toEqual(new Set([keptNote]));
      expect(await alive(tx, "quota", scope.quotaUsageIds!)).toEqual(new Set([keptQuota]));
      expect(await alive(tx, "events", scope.eventIds!)).toEqual(new Set([matched.id]));

      expect(await runRetention(tx, now, { scope })).toEqual({ tasks: 0, notifications: 0, quotaUsage: 0, paymentEvents: 0 });
    });
  });

  test("one run deletes at most `limit` rows per table; later runs take the rest", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const scope = scopeOf(await seed(tx, user.id, 7));
      expect(await runRetention(tx, now, { scope, limit: 5 })).toEqual({ tasks: 5, notifications: 5, quotaUsage: 5, paymentEvents: 5 });
      expect(await runRetention(tx, now, { scope, limit: 5 })).toEqual({ tasks: 2, notifications: 2, quotaUsage: 2, paymentEvents: 2 });
      expect(await runRetention(tx, now, { scope, limit: 5 })).toEqual({ tasks: 0, notifications: 0, quotaUsage: 0, paymentEvents: 0 });
    });
    expect(RETENTION_BATCH).toBe(2_000); // the production batch
  });

  test("the number of statements does not depend on the number of rows (one per table)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const few = scopeOf(await seed(tx, user.id, 1));
      const many = scopeOf(await seed(tx, user.id, 15));
      const a = await countQueries(() => runRetention(tx, now, { scope: few }));
      const b = await countQueries(() => runRetention(tx, now, { scope: many }));
      expect(a.result.tasks).toBe(1);
      expect(b.result.tasks).toBe(15);
      expect(a.queries).toBe(4);
      expect(b.queries).toBe(4);
      expect((await countQueries(() => runRetention(tx, now, { scope: many }))).queries).toBe(4); // and idle: still 4, nothing grows
    });
  });

  test("a failing table is reported at the end and does not stop the others", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const scope = scopeOf(await seed(tx, user.id, 2));
      let calls = 0;
      const flaky = new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "execute") return typeof value === "function" ? value.bind(target) : value;
          return (...args: unknown[]) => {
            if (++calls === 2) throw new Error("notifications table is locked"); // statement order: tasks, notifications, quota, events
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as DbLike;

      await expect(runRetention(flaky, now, { scope })).rejects.toThrow("maintenance.retention: notifications: notifications table is locked");
      expect(await alive(tx, "tasks", scope.taskIds!)).toEqual(new Set());
      expect(await alive(tx, "notifications", scope.notificationIds!)).toEqual(new Set(scope.notificationIds)); // the one that failed
      expect(await alive(tx, "quota", scope.quotaUsageIds!)).toEqual(new Set());
      expect(await alive(tx, "events", scope.eventIds!)).toEqual(new Set());
    });
  });

  test("a scope is mandatory once given: unlisted tables are skipped, empty lists and bad limits are refused", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const gone = await seed(tx, user.id, 2);
      // Only tasks are scoped: nothing else may run (an unscoped delete here would reach real rows).
      const { result, queries } = await countQueries(() => runRetention(tx, now, { scope: { taskIds: gone.taskIds } }));
      expect(result).toEqual({ tasks: 2, notifications: 0, quotaUsage: 0, paymentEvents: 0 });
      expect(queries).toBe(1);
      expect(await alive(tx, "notifications", gone.notificationIds)).toEqual(new Set(gone.notificationIds));

      await expect(runRetention(tx, now, { scope: { taskIds: [] } })).rejects.toThrow("non-empty");
      await expect(runRetention(tx, now, { scope: { taskIds: [""] } })).rejects.toThrow("non-empty");
      await expect(runRetention(tx, now, { scope: { taskIds: gone.taskIds }, limit: 0 })).rejects.toThrow("positive integer");
      await expect(purgeOldTasks(tx, now, { ids: [] })).rejects.toThrow("non-empty");
    });
  });
});
