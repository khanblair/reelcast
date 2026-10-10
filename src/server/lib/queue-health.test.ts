/**
 * Queue depth (scaling ladder M-3 / M-4). The database is shared with the live tick, so every case counts only the rows of
 * its own synthetic user (`scope`, the same mechanism queue.ts offers tests) inside a transaction that is rolled back.
 * Inside one transaction `now()` is fixed, so planted ages come back exactly.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { jobs, tasks, videos } from "@/db/schema";
import { countQueries, inRolledBackTx } from "@/server/testing";
import { TICK_STALE_MS, getFailedTasks, getQueueDepth, getScheduleHealth, scrubError } from "./queue-health";

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

// ─── failed tasks, sweep errors, the heartbeat (admin only) ──────────────────────────────────────────────────────────

describe("scrubError", () => {
  test("cuts a Drizzle failed-query message before its bound values, then truncates", () => {
    const text = "Failed query: update users set email = $1 where id = $2\nparams: victim@example.com,11111111-2222";
    const out = scrubError(text)!;
    expect(out).toBe("Failed query: update users set email = $1 where id = $2");
    expect(out).not.toContain("victim@example.com");
    expect(scrubError("x".repeat(1_000))).toHaveLength(300);
  });

  test("a failed-query message whose SQL is long is truncated AFTER the values are cut, never before", () => {
    const text = `Failed query: select ${"a, ".repeat(200)}from t\nparams: LEAKSENTINEL`;
    expect(scrubError(text)).not.toContain("LEAKSENTINEL");
    expect(scrubError(text)!.length).toBeLessThanOrEqual(300);
  });

  test("other text is kept, and null stays null", () => {
    expect(scrubError("connect ETIMEDOUT")).toBe("connect ETIMEDOUT");
    expect(scrubError(null)).toBeNull();
    expect(scrubError("")).toBe("");
  });
});

describe("getFailedTasks", () => {
  test("lists the user's failed tasks newest first, capped, with scrubbed and truncated errors and no payload", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const rows = Array.from({ length: 25 }, (_, i) => ({
        kind: `test.failed-${i}`,
        userId: user.id,
        status: "failed" as const,
        attempts: 3,
        maxAttempts: 3,
        updatedAt: sql`now() - ${i} * interval '1 minute'`, // i = 0 is the newest
        payload: { secret: "LEAKSENTINEL_PAYLOAD" },
        lastError: i === 0 ? "Failed query: select 1 where email = $1\nparams: LEAKSENTINEL@example.com" : i === 1 ? "e".repeat(1_000) : `boom ${i}`,
      }));
      await tx.insert(tasks).values(rows);
      await tx.insert(tasks).values([
        { kind: "test.pending", userId: user.id, status: "pending" },
        { kind: "test.done", userId: user.id, status: "done" },
        { kind: "test.running", userId: user.id, status: "running" },
      ]);

      const list = await getFailedTasks(tx, 20, { userId: user.id });
      expect(list).toHaveLength(20);
      expect(list.map((t) => t.kind)).toEqual(Array.from({ length: 20 }, (_, i) => `test.failed-${i}`));
      expect(list[0]).toMatchObject({ attempts: 3, maxAttempts: 3, lastError: "Failed query: select 1 where email = $1" });
      expect(list[1].lastError).toHaveLength(300);
      expect(list[0].failedAt).toBeInstanceOf(Date);
      expect(Object.keys(list[0]).sort()).toEqual(["attempts", "failedAt", "id", "kind", "lastError", "maxAttempts"]);
      expect(JSON.stringify(list)).not.toContain("LEAKSENTINEL");
      expect((await getFailedTasks(tx, 3, { userId: user.id })).map((t) => t.kind)).toEqual(["test.failed-0", "test.failed-1", "test.failed-2"]);
    });
  });

  test("is ONE statement however many tasks failed", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      expect((await countQueries(() => getFailedTasks(tx, 20, { userId: user.id }))).queries).toBe(1);
      await plantTasks(tx, user.id, Array.from({ length: 60 }, (): Planted => ["failed"]));
      const many = await countQueries(() => getFailedTasks(tx, 20, { userId: user.id }));
      expect(many.queries).toBe(1);
      expect(many.result).toHaveLength(20);
    });
  });
});

describe("getScheduleHealth", () => {
  const uid = () => randomUUID();
  async function plantSchedule(tx: DbLike, name: string, o: { ageMs?: number | null; error?: string | null } = {}) {
    await tx.execute(sql`
      insert into job_schedules (name, last_run_at, last_error)
      values (${name}, ${o.ageMs === undefined || o.ageMs === null ? null : sql`now() - ${o.ageMs} * interval '1 millisecond'`}, ${o.error ?? null})
    `);
    return name;
  }

  test("lists failing sweeps with their last run, and leaves out healthy sweeps, digest markers and the heartbeat row", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const failing = await plantSchedule(tx, `test-sweep-${uid()}`, { ageMs: 90_000, error: "Failed query: select 1 where x = $1\nparams: LEAKSENTINEL" });
      const healthy = await plantSchedule(tx, `test-sweep-ok-${uid()}`, { ageMs: 5_000 });
      const marker = await plantSchedule(tx, `digest:test-${uid()}:2026-W41`, { ageMs: 5_000, error: "marker with an error" });
      const weekMarker = await plantSchedule(tx, `digest-week:test-${uid()}`, { ageMs: 5_000, error: "week marker with an error" });
      const beat = await plantSchedule(tx, `test.heartbeat.${uid()}`, { ageMs: 1_000, error: "2 errors: sweep a: boom" });

      const h = await getScheduleHealth(tx, beat);
      const names = h.scheduleErrors.map((e) => e.name);
      expect(names).toContain(failing);
      for (const left of [healthy, marker, weekMarker, beat]) expect(names).not.toContain(left);
      const row = h.scheduleErrors.find((e) => e.name === failing)!;
      expect(row.lastError).toBe("Failed query: select 1 where x = $1");
      expect(row.lastRunAt).toBeInstanceOf(Date);
      expect(JSON.stringify(h)).not.toContain("LEAKSENTINEL");
      // the heartbeat's own error summary is the tick's `lastError`
      expect(h.tick).toMatchObject({ ageMs: 1_000, stale: false, lastError: "2 errors: sweep a: boom" });
    });
  });

  test("the real heartbeat row is never listed as a sweep error", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const h = await getScheduleHealth(tx);
      expect(h.scheduleErrors.map((e) => e.name)).not.toContain("tick.heartbeat");
    });
  });

  test("tick: fresh is not stale, exactly 3 minutes is not stale, 1 ms more is, no row is neither stale nor recorded", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const fresh = await plantSchedule(tx, `test.heartbeat.${uid()}`, { ageMs: 0 });
      const edge = await plantSchedule(tx, `test.heartbeat.${uid()}`, { ageMs: TICK_STALE_MS });
      const stale = await plantSchedule(tx, `test.heartbeat.${uid()}`, { ageMs: TICK_STALE_MS + 1 });
      const unset = await plantSchedule(tx, `test.heartbeat.${uid()}`, { ageMs: null }); // a row with last_run_at null
      const none = `test.heartbeat.${uid()}`; // no row at all
      const tick = async (name: string) => (await getScheduleHealth(tx, name)).tick;
      expect(await tick(fresh)).toMatchObject({ ageMs: 0, stale: false, lastError: null });
      expect(await tick(edge)).toMatchObject({ ageMs: TICK_STALE_MS, stale: false });
      expect(await tick(stale)).toMatchObject({ ageMs: TICK_STALE_MS + 1, stale: true });
      expect(await tick(unset)).toEqual({ lastRunAt: null, ageMs: null, stale: false, lastError: null });
      expect(await tick(none)).toEqual({ lastRunAt: null, ageMs: null, stale: false, lastError: null });
    });
  });

  test("is ONE statement however many sweeps are failing", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const beat = `test.heartbeat.${uid()}`;
      expect((await countQueries(() => getScheduleHealth(tx, beat))).queries).toBe(1);
      for (let i = 0; i < 5; i++) await plantSchedule(tx, `test-sweep-${uid()}`, { ageMs: 1_000, error: `boom ${i}` });
      expect((await countQueries(() => getScheduleHealth(tx, beat))).queries).toBe(1);
    });
  });
});
