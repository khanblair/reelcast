/**
 * Concurrency tests need REAL committed rows (SKIP LOCKED only matters across separate
 * connections), so they use a throwaway user plus videos/jobs/tasks it owns, and delete them after.
 *
 * The database may be the production one, so every claim / recover / tick call here carries
 * `scope: { userId }` (the throwaway user) and goes through `refuseUnscopedQueueSql`: a call that forgot
 * the scope throws instead of claiming a real job. The `scope` describe at the end proves the scoping
 * itself inside a rolled-back transaction, where nothing can persist.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray, like } from "drizzle-orm";
import { db } from "@/db/client";
import { jobSchedules, jobs, tasks, usageLedger, users, videos } from "@/db/schema";
import { consumeQuota, monthKey } from "@/server/lib/usage";
import { mkJob, mkVideo as mkTxVideo } from "@/server/lib/publish/dbkit";
import { countQueries, createCommittedTestUser, deleteCommittedTestUsers, inRolledBackTx, refuseUnscopedQueueSql } from "@/server/testing";
import {
  backoffMs, cancelTask, claimJobs, claimTasks, completeJob, deferJob, enqueueJob, enqueueTask, failJob, failTask, recoverStale, requeueJob,
} from "./queue";
import { runTick } from "./tick";
import { NonRetryableError } from "./handlers";

// Remote Postgres round trips are slow; the default 5s timeout would let afterAll delete rows mid-test.
setDefaultTimeout(60_000);

const MARK = `qtest-${Date.now()}`; // no LIKE wildcards in it: the afterAll deletes match `MARK%`
let userId = "";
const videoIds: string[] = [];
/** Every claim / recover / tick below uses these two. */
const qdb = refuseUnscopedQueueSql(db);
const own = () => ({ userId });

async function mkVideo(title: string) {
  const [v] = await db.insert(videos).values({ userId, title: `${MARK} ${title}`, rawFileKey: "x", rawFileSize: 1 }).returning();
  videoIds.push(v.id);
  return v;
}

beforeAll(async () => {
  // A throwaway user committed for the whole file (concurrency tests need committed rows); no real account is touched.
  userId = (await createCommittedTestUser()).id;
});

afterAll(async () => {
  if (videoIds.length) await db.delete(videos).where(inArray(videos.id, videoIds)); // cascades jobs
  await db.delete(tasks).where(like(tasks.kind, `${MARK}%`));
  await db.delete(jobSchedules).where(like(jobSchedules.name, `${MARK}%`));
  await deleteCommittedTestUsers([userId]); // cascades ledger rows, jobs and tasks
});

describe("jobs", () => {
  test("only one active job per (video, type): duplicates return the existing job", async () => {
    const v = await mkVideo("dedupe");
    const a = await enqueueJob(db, { userId, videoId: v.id, type: "publish" });
    const b = await enqueueJob(db, { userId, videoId: v.id, type: "publish" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    // a different type is independent
    expect((await enqueueJob(db, { userId, videoId: v.id, type: "generation" })).created).toBe(true);
  });

  test("two workers claiming concurrently never get the same job", async () => {
    const vids = await db
      .insert(videos)
      .values(Array.from({ length: 8 }, (_, i) => ({ userId, title: `${MARK} claim-${i}`, rawFileKey: "x", rawFileSize: 1 })))
      .returning();
    videoIds.push(...vids.map((v) => v.id));
    const created = await db
      .insert(jobs)
      .values(vids.map((v) => ({ userId, videoId: v.id, type: "publish" as const, runAt: new Date(Date.now() - 1000) })))
      .returning();
    const mine = created.map((j) => j.id);
    const [x, y] = await Promise.all([claimJobs(qdb, 5, ["publish"], own()), claimJobs(qdb, 5, ["publish"], own())]);
    const claimedMine = [...x, ...y].map((j) => j.id).filter((id) => mine.includes(id));
    expect(new Set(claimedMine).size).toBe(claimedMine.length); // no duplicates
    expect(claimedMine.length).toBe(8); // and nothing was dropped
    expect([...x, ...y].every((j) => j.status === "processing" && j.attempts === 1)).toBe(true);
  });

  test("retry with backoff until maxAttempts, then failed; non-retryable fails immediately", async () => {
    const v = await mkVideo("retry");
    const { job } = await enqueueJob(db, { userId, videoId: v.id, type: "publish", maxAttempts: 2 });
    await db.update(jobs).set({ status: "processing", attempts: 1 }).where(eq(jobs.id, job.id));
    expect(await failJob(db, { ...job, attempts: 1 }, "boom")).toBe("pending");
    const [after1] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after1.runAt.getTime()).toBeGreaterThan(Date.now() + backoffMs(1) - 5000);
    expect(await failJob(db, { ...job, attempts: 2 }, "boom again")).toBe("failed");
    expect(await requeueJob(db, job.id)).not.toBeNull(); // user-initiated retry
    await db.update(jobs).set({ status: "processing" }).where(eq(jobs.id, job.id));
    expect(await failJob(db, { ...job, attempts: 1 }, "fatal", { retryable: false })).toBe("failed");
  });

  test("deferJob keeps the job pending without burning an attempt", async () => {
    const v = await mkVideo("defer");
    const { job } = await enqueueJob(db, { userId, videoId: v.id, type: "generation", runAt: new Date(Date.now() - 1000) });
    const [claimed] = (await claimJobs(qdb, 50, ["generation"], own())).filter((j) => j.id === job.id);
    expect(claimed.attempts).toBe(1);
    await deferJob(db, claimed, 60_000, { step: "polling", op: "abc" });
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(row.metadata).toEqual({ step: "polling", op: "abc" });
    expect((await claimJobs(qdb, 50, ["generation"], own())).some((j) => j.id === job.id)).toBe(false); // not due yet
  });

  test("stale processing rows are recovered (and failed once attempts are exhausted)", async () => {
    const v1 = await mkVideo("stale-a");
    const v2 = await mkVideo("stale-b");
    const a = (await enqueueJob(db, { userId, videoId: v1.id, type: "publish" })).job;
    const b = (await enqueueJob(db, { userId, videoId: v2.id, type: "publish", maxAttempts: 1 })).job;
    const old = new Date(Date.now() - 3_600_000);
    await db.update(jobs).set({ status: "processing", lockedAt: old, attempts: 1 }).where(inArray(jobs.id, [a.id, b.id]));
    await recoverStale(qdb, 600_000, own());
    const rows = await db.select().from(jobs).where(inArray(jobs.id, [a.id, b.id]));
    expect(rows.find((r) => r.id === a.id)?.status).toBe("pending");
    expect(rows.find((r) => r.id === b.id)?.status).toBe("failed");
    await completeJob(db, a.id);
  });
});

describe("tasks", () => {
  test("dedupeKey makes pending tasks unique and cancellable", async () => {
    const key = `${MARK}:poll`;
    const a = await enqueueTask(db, { kind: `${MARK}.poll`, userId, dedupeKey: key });
    const b = await enqueueTask(db, { kind: `${MARK}.poll`, userId, dedupeKey: key });
    expect(b.created).toBe(false);
    expect(b.task.id).toBe(a.task.id);
    expect(await cancelTask(db, key)).toBe(true);
    expect((await enqueueTask(db, { kind: `${MARK}.poll`, userId, dedupeKey: key })).created).toBe(true); // key is free again
    await cancelTask(db, key);
  });

  test("future tasks are not claimed; due ones are", async () => {
    const later = await enqueueTask(db, { kind: `${MARK}.later`, userId, runAt: new Date(Date.now() + 3_600_000) });
    const due = await enqueueTask(db, { kind: `${MARK}.due`, userId });
    const claimed = await claimTasks(qdb, 10, [`${MARK}.later`, `${MARK}.due`], own());
    expect(claimed.map((t) => t.id)).toEqual([due.task.id]);
    await failTask(db, claimed[0], "x", { retryable: false });
    await cancelTask(db, later.task.id).catch(() => {});
  });
});

describe("tick", () => {
  test("a sweep runs once per interval even when ticks overlap", async () => {
    let runs = 0;
    const sweep = { name: `${MARK}.sweep`, everyMs: 3_600_000, run: async () => void runs++ };
    const opts = { db: qdb, scope: own(), sweeps: [sweep], budgetMs: 2000, drain: false };
    await Promise.all([runTick(opts), runTick(opts), runTick(opts)]);
    expect(runs).toBe(1);
  });
  test("a throwing sweep does not break the tick and is reported", async () => {
    const r = await runTick({ db: qdb, scope: own(), sweeps: [{ name: `${MARK}.bad`, everyMs: 1, run: async () => { throw new Error("nope"); } }], budgetMs: 2000, drain: false });
    expect(r.errors.some((e) => e.includes("nope"))).toBe(true);
  });
  test("onJobFailed fires when stale recovery gives up on a job (worker died on its last attempt)", async () => {
    const v = await mkVideo("hook");
    const { job } = await enqueueJob(db, { userId, videoId: v.id, type: "publish", maxAttempts: 1 });
    await db.update(jobs).set({ status: "processing", attempts: 1, lockedAt: new Date(Date.now() - 3_600_000) }).where(eq(jobs.id, job.id));
    const seen: string[] = [];
    const r = await runTick({ db: qdb, scope: own(), sweeps: [], budgetMs: 2000, drain: false, jobFailedHooks: { publish: async (j) => void seen.push(j.id) } });
    expect(seen).toContain(job.id);
    expect(r.recovered.failedJobs).toBe(1); // exactly this test job: the scope keeps real stuck jobs out
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("failed");
  });
  test("a throwing hook is reported but does not break the tick", async () => {
    const v = await mkVideo("hook-throws");
    const { job } = await enqueueJob(db, { userId, videoId: v.id, type: "publish", maxAttempts: 1 });
    await db.update(jobs).set({ status: "processing", attempts: 1, lockedAt: new Date(Date.now() - 3_600_000) }).where(eq(jobs.id, job.id));
    const r = await runTick({ db: qdb, scope: own(), sweeps: [], budgetMs: 2000, drain: false, jobFailedHooks: { publish: async () => { throw new Error("hook boom"); } } });
    expect(r.errors.some((e) => e.includes("hook boom"))).toBe(true);
  });
  test("NonRetryableError is a real class", () => {
    expect(new NonRetryableError("x").retryable).toBe(false);
  });
});

describe("quota (atomic)", () => {
  test("concurrent consumers can never exceed the plan limit", async () => {
    await db.update(users).set({ plan: "free" }).where(eq(users.id, userId));
    const month = monthKey();
    const before = (await db.select().from(usageLedger).where(eq(usageLedger.userId, userId))).filter((r) => r.month === month);
    await db.delete(usageLedger).where(eq(usageLedger.userId, userId));
    try {
      // free plan: metadataGenerated limit = 5
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => consumeQuota(db, userId, "metadataGenerated")));
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(5);
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(failures.length).toBe(7);
      expect(String(failures[0].reason.message)).toContain("PLAN_LIMIT_EXCEEDED:metadataGenerated:free");
      // zero-limit features are refused outright
      await expect(consumeQuota(db, userId, "veoGenerated")).rejects.toThrow("PLAN_LIMIT_EXCEEDED:veoGenerated:free");
    } finally {
      await db.delete(usageLedger).where(eq(usageLedger.userId, userId));
      if (before.length) await db.insert(usageLedger).values(before.map((r) => ({ userId: r.userId, month: r.month, videosUploaded: r.videosUploaded, metadataGenerated: r.metadataGenerated, veoGenerated: r.veoGenerated, aiMessagesUsed: r.aiMessagesUsed })));
    }
  });
});

// ─── scoping: a call can only reach the rows it names ─────────────────────────────────────────────────
// Rolled back, so nothing persists even if a mutation of the code under test touches real rows.

describe("scope", () => {
  const OLD = new Date("1975-01-01T00:00:00Z"); // sorts before every real row; stale for any cutoff
  const KIND = "__scope_probe"; // no handler is registered for it
  type Tx = Parameters<Parameters<typeof inRolledBackTx>[0]>[0]["tx"];

  const pendingJob = async (tx: Tx, owner: string, over: Partial<typeof jobs.$inferInsert> = {}) =>
    (await mkJob(tx, owner, (await mkTxVideo(tx, owner)).id, { status: "pending", lockedAt: null, attempts: 0, runAt: OLD, ...over })).id;
  const task = async (tx: Tx, owner: string | null, over: Partial<typeof tasks.$inferInsert> = {}) =>
    (await tx.insert(tasks).values({ kind: KIND, userId: owner, runAt: OLD, ...over }).returning({ id: tasks.id }))[0].id;
  const jobStatus = async (tx: Tx, id: string) => (await tx.select({ s: jobs.status }).from(jobs).where(eq(jobs.id, id)))[0].s;
  const taskStatus = async (tx: Tx, id: string) => (await tx.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id)))[0].s;

  test("claimJobs claims only the scoped user's due jobs, even when another user's are older", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const theirs = await pendingJob(tx, other.id, { runAt: OLD });
      const mine = await pendingJob(tx, user.id, { runAt: new Date(OLD.getTime() + 1000) });
      const claimed = await claimJobs(tx, 10, undefined, { userId: user.id });
      expect(claimed.map((j) => j.id)).toEqual([mine]);
      expect(await jobStatus(tx, theirs)).toBe("pending");
      expect(await jobStatus(tx, mine)).toBe("processing");
    });
  });

  test("claimTasks claims only the scoped user's due tasks; other users' and user-less tasks are out of scope", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const orphan = await task(tx, null);
      const theirs = await task(tx, other.id);
      const mine = await task(tx, user.id, { runAt: new Date(OLD.getTime() + 1000) });
      const claimed = await claimTasks(tx, 10, undefined, { userId: user.id });
      expect(claimed.map((t) => t.id)).toEqual([mine]);
      expect(await taskStatus(tx, orphan)).toBe("pending");
      expect(await taskStatus(tx, theirs)).toBe("pending");
    });
  });

  test("recoverStale recovers only the scoped user's stuck jobs and tasks", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const stuck = (owner: string) => pendingJob(tx, owner, { status: "processing", lockedAt: OLD, attempts: 1 });
      const [myJob, theirJob] = [await stuck(user.id), await stuck(other.id)];
      const running = { status: "running" as const, lockedAt: OLD, attempts: 1 };
      const [myTask, theirTask, orphanTask] = [await task(tx, user.id, running), await task(tx, other.id, running), await task(tx, null, running)];

      const out = await recoverStale(tx, 600_000, { userId: user.id });
      expect({ jobs: out.jobs, tasks: out.tasks }).toEqual({ jobs: 1, tasks: 1 });
      expect(await jobStatus(tx, myJob)).toBe("pending");
      expect(await jobStatus(tx, theirJob)).toBe("processing");
      expect(await taskStatus(tx, myTask)).toBe("pending");
      expect(await taskStatus(tx, theirTask)).toBe("running");
      expect(await taskStatus(tx, orphanTask)).toBe("running");
    });
  });

  test("a scope without a usable userId throws before any statement runs (it never widens to everything)", async () => {
    await inRolledBackTx(async ({ tx }) => {
      for (const bad of [{ userId: "" }, {}, { userId: undefined }, { userId: null }] as never[]) {
        const { queries } = await countQueries(async () => {
          for (const call of [() => claimJobs(tx, 1, undefined, bad), () => claimTasks(tx, 1, undefined, bad), () => recoverStale(tx, 1, bad)]) {
            await expect(call()).rejects.toThrow("non-empty userId");
          }
        });
        expect(queries).toBe(0);
      }
    });
  });

  test("runTick recovers and drains only the scoped user's rows", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const exhausted = { status: "processing" as const, lockedAt: OLD, attempts: 1, maxAttempts: 1 }; // recovery fails it for good: nothing to drain afterwards
      const myStale = await pendingJob(tx, user.id, exhausted);
      const theirStale = await pendingJob(tx, other.id, exhausted);
      const theirJob = await pendingJob(tx, other.id);
      const myTask = await task(tx, user.id);
      const theirTask = await task(tx, other.id);

      // The guard makes a tick that forgot the scope throw instead of running a real job's handler.
      const r = await runTick({ db: refuseUnscopedQueueSql(tx), scope: { userId: user.id }, sweeps: [], jobFailedHooks: {}, staleMs: 600_000, budgetMs: 30_000 });
      expect(r.errors).toEqual([]);
      expect(r.recovered).toEqual({ jobs: 1, tasks: 0, failedJobs: 1 });
      expect({ jobsRun: r.jobsRun, tasksRun: r.tasksRun }).toEqual({ jobsRun: 0, tasksRun: 1 });
      expect(await jobStatus(tx, myStale)).toBe("failed");
      expect(await taskStatus(tx, myTask)).toBe("failed"); // no handler: failed for good
      expect(await jobStatus(tx, theirStale)).toBe("processing");
      expect(await jobStatus(tx, theirJob)).toBe("pending");
      expect(await taskStatus(tx, theirTask)).toBe("pending");
    });
  });
});
