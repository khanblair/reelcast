/**
 * Queue depth (scaling ladder M-3 / M-4). The database is shared with the live tick, so every case counts only the rows of
 * its own synthetic user (`scope`, the same mechanism queue.ts offers tests) inside a transaction that is rolled back.
 * Inside one transaction `now()` is fixed, so planted ages come back exactly.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { jobs, tasks, videos } from "@/db/schema";
import { countQueries, inRolledBackTx } from "@/server/testing";
import { getQueueDepth } from "./queue-health";

setDefaultTimeout(120_000);

const ago = (interval: string) => sql`now() - ${sql.raw(`interval '${interval}'`)}`;
const ahead = (interval: string) => sql`now() + ${sql.raw(`interval '${interval}'`)}`;

type TaskStatus = (typeof tasks.$inferInsert)["status"];
type JobStatus = (typeof jobs.$inferInsert)["status"];
type Planted = [status: string, when?: { runAt?: ReturnType<typeof sql>; updatedAt?: ReturnType<typeof sql> }];

/** One multi-row insert (every statement is a network round trip, and these tests plant dozens of rows). */
async function plantTasks(tx: DbLike, userId: string, rows: Planted[]) {
  await tx.insert(tasks).values(rows.map(([status, w]) => ({ kind: "test.queue-health", userId, status: status as TaskStatus, runAt: w?.runAt ?? ago("1 second"), updatedAt: w?.updatedAt ?? sql`now()` })));
}

/** Active jobs are unique per (video, type), so each gets its own video. */
async function plantJobs(tx: DbLike, userId: string, rows: Planted[]) {
  const vids = await tx.insert(videos).values(rows.map(() => ({ userId, title: "t", rawFileKey: "https://res.cloudinary.com/demo/video/upload/v1/x.mp4", rawFileSize: 10 }))).returning({ id: videos.id });
  await tx.insert(jobs).values(rows.map(([status, w], i) => ({ userId, videoId: vids[i].id, type: "publish" as const, status: status as JobStatus, runAt: w?.runAt ?? ago("1 second"), updatedAt: w?.updatedAt ?? sql`now()` })));
}

describe("getQueueDepth", () => {
  test("counts due pending, scheduled, processing and recent failures for jobs and tasks, and the oldest DUE age", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      // tasks: 2 due (10 min and 5 min late), 1 scheduled for later, 1 running, 1 failed now, 1 failed 25 h ago, done/cancelled (ignored)
      await plantTasks(tx, user.id, [
        ["pending", { runAt: ago("10 minutes") }],
        ["pending", { runAt: ago("5 minutes") }],
        ["pending", { runAt: ahead("1 hour") }],
        ["running"],
        ["failed"],
        ["failed", { updatedAt: ago("25 hours") }],
        ["done"],
        ["cancelled"],
      ]);
      // jobs: 1 due (2 min late), 1 scheduled (retry backoff), 1 processing, 1 failed now, 1 failed 25 h ago, 1 completed
      await plantJobs(tx, user.id, [
        ["pending", { runAt: ago("2 minutes") }],
        ["pending", { runAt: ahead("30 seconds") }],
        ["processing"],
        ["failed"],
        ["failed", { updatedAt: ago("25 hours") }],
        ["completed"],
      ]);

      const d = await getQueueDepth(tx, { userId: user.id });
      expect(d.tasks).toEqual({ pending: 2, scheduled: 1, processing: 1, failedLast24h: 1, oldestPendingAgeMs: 10 * 60_000 });
      expect(d.jobs).toEqual({ pending: 1, scheduled: 1, processing: 1, failedLast24h: 1, oldestPendingAgeMs: 2 * 60_000 });
      expect(d.oldestPendingAgeMs).toBe(10 * 60_000);
    });
  });

  test("work that is only scheduled for later is not backlog: pending 0 and no oldest age", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await plantTasks(tx, user.id, [1, 2, 3, 4, 5].map((h): Planted => ["pending", { runAt: ahead(`${h} hours`) }]));
      await plantJobs(tx, user.id, [["pending", { runAt: ahead("1 minute") }]]);
      const d = await getQueueDepth(tx, { userId: user.id });
      expect(d.tasks).toMatchObject({ pending: 0, scheduled: 5, oldestPendingAgeMs: null });
      expect(d.jobs).toMatchObject({ pending: 0, scheduled: 1, oldestPendingAgeMs: null });
      expect(d.oldestPendingAgeMs).toBeNull();
    });
  });

  test("an empty queue still answers, with zeros and no age", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const empty = { pending: 0, scheduled: 0, processing: 0, failedLast24h: 0, oldestPendingAgeMs: null };
      expect(await getQueueDepth(tx, { userId: user.id })).toEqual({ jobs: empty, tasks: empty, oldestPendingAgeMs: null });
    });
  });

  test("is ONE statement however many rows there are", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const one = await countQueries(() => getQueueDepth(tx, { userId: user.id }));
      expect(one.queries).toBe(1);
      await plantTasks(tx, user.id, Array.from({ length: 30 }, (_, i): Planted => [i % 3 === 0 ? "failed" : "pending"]));
      await plantJobs(tx, user.id, Array.from({ length: 5 }, (_, i): Planted => [i % 2 === 0 ? "failed" : "pending"]));
      const many = await countQueries(() => getQueueDepth(tx, { userId: user.id }));
      expect(many.queries).toBe(1);
      expect(many.result.tasks.pending + many.result.tasks.failedLast24h).toBe(30);
    });
  });

  test("a scope without a user id is refused instead of matching everything", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await expect(getQueueDepth(tx, { userId: "" })).rejects.toThrow(/non-empty userId/);
    });
  });

  test("without a scope it reads the whole table (shape only: the database holds real rows)", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const d = await getQueueDepth(tx);
      for (const c of [d.jobs, d.tasks]) {
        for (const k of ["pending", "scheduled", "processing", "failedLast24h"] as const) expect(Number.isInteger(c[k]) && c[k] >= 0).toBe(true);
        expect(c.oldestPendingAgeMs === null || c.oldestPendingAgeMs >= 0).toBe(true);
      }
    });
  });
});
