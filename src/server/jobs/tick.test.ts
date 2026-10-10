/**
 * Statement count and claiming rules of the tick's recovery and sweep phases, and the tick heartbeat.
 *
 * Every test runs in a transaction that is rolled back (`db: tx`), so it is deterministic: the live dev
 * server's ticker can neither see nor race these rows, and nothing persists. The drain is never run here
 * (`drain: false`): against the shared database it would claim and run real jobs. `staleMs` is chosen so
 * that no real row can be recovered (and no real onJobFailed hook can fire) by these tests.
 *
 * The heartbeat is written under a test-unique name (`opts` below), never `tick.heartbeat`: even rolled back, an upsert of
 * the live row would hold its row lock and block the production tick's own heartbeat for the length of a test.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { tasks } from "@/db/schema";
import { mkJob, mkVideo } from "@/server/lib/publish/dbkit";
import { countQueries, inRolledBackTx } from "@/server/testing";
import { sweeps as defaultSweeps, type Sweep } from "./handlers";
import { TICK_HEARTBEAT, getTickHeartbeat, summarizeTickErrors, writeTickHeartbeat } from "./heartbeat";
import { recoverStale } from "./queue";
import { runTick, type TickOptions } from "./tick";

setDefaultTimeout(180_000);

/** Nothing real is this old, so recovery finds no real row. */
const NO_STALE_MS = 10 * 365 * 24 * 3_600_000;
const sweepName = () => `__tick_${randomUUID()}`;
const heartbeatName = () => `__tick_hb_${randomUUID()}`;

type Sched = { lastRun: SQL; lease?: SQL };
const NOW = sql`now()`;
const HOURS_AGO_2 = sql`now() - interval '2 hours'`;

async function seed(tx: DbLike, name: string, { lastRun, lease }: Sched) {
  await tx.execute(sql`insert into job_schedules (name, last_run_at, lease_until) values (${name}, ${lastRun}, ${lease ?? sql`null`})`);
}

async function schedule(tx: DbLike, name: string) {
  const rows = (await tx.execute(sql`select last_run_at::text as last_run_at, lease_until::text as lease_until, last_error from job_schedules where name = ${name}`)) as unknown as {
    last_run_at: string | null;
    lease_until: string | null;
    last_error: string | null;
  }[];
  return rows[0];
}

const sweepOf = (name: string, ran: string[], everyMs = 3_600_000): Sweep => ({ name, everyMs, run: async () => void ran.push(name) });
const opts = (tx: DbLike, sweeps: Sweep[], extra: TickOptions = {}) => ({
  db: tx,
  drain: false,
  sweeps,
  staleMs: NO_STALE_MS,
  jobFailedHooks: {},
  heartbeat: heartbeatName(),
  ...extra,
});

describe("idle tick", () => {
  test("recovery plus the sweep check cost the same number of statements for 1 sweep and for 8", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const counts: Record<number, number> = {};
      for (const k of [1, 8]) {
        const ran: string[] = [];
        const sweeps = Array.from({ length: k }, () => sweepOf(sweepName(), ran));
        for (const s of sweeps) await seed(tx, s.name, { lastRun: NOW }); // ran "just now": not due for an hour
        const { result, queries } = await countQueries(() => runTick(opts(tx, sweeps)));
        expect(result.sweepsRun).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(ran).toEqual([]);
        counts[k] = queries;
      }
      expect(counts[8]).toBe(counts[1]);
      // 1 stale probe + 1 due check + 1 heartbeat (the drain, not run here, adds its own claim round). The heartbeat raised
      // this from 2 on purpose (scaling ladder M-2); it must stay ONE statement per tick.
      expect(counts[1]).toBe(3);
    });
  });

  test("no sweeps: the stale probe and the heartbeat; an already-spent budget: nothing but those two and no sweep row is touched", async () => {
    await inRolledBackTx(async ({ tx }) => {
      expect((await countQueries(() => runTick(opts(tx, [])))).queries).toBe(2); // was 1 before the heartbeat

      const ran: string[] = [];
      const due = sweepOf(sweepName(), ran);
      const { result, queries } = await countQueries(() => runTick(opts(tx, [due], { budgetMs: 0 })));
      expect(queries).toBe(2); // was 1 before the heartbeat
      expect(result.sweepsRun).toEqual([]);
      expect(await schedule(tx, due.name)).toBeUndefined(); // not even seeded
    });
  });
});

describe("sweep claiming", () => {
  test("runs exactly the due sweeps, in order, and releases their leases; the others are untouched", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const n = { missing: sweepName(), notDue: sweepName(), dueOld: sweepName(), leased: sweepName(), neverRan: sweepName(), expiredLease: sweepName() };
      await seed(tx, n.notDue, { lastRun: NOW });
      await seed(tx, n.dueOld, { lastRun: HOURS_AGO_2 });
      await seed(tx, n.leased, { lastRun: HOURS_AGO_2, lease: sql`now() + interval '1 hour'` }); // another worker is running it
      await seed(tx, n.neverRan, { lastRun: sql`null` });
      await seed(tx, n.expiredLease, { lastRun: HOURS_AGO_2, lease: sql`now() - interval '1 minute'` }); // its worker died
      const before = Object.fromEntries(await Promise.all(Object.values(n).map(async (name) => [name, await schedule(tx, name)] as const)));

      const ran: string[] = [];
      const order = [n.missing, n.notDue, n.dueOld, n.leased, n.neverRan, n.expiredLease];
      const result = await runTick(opts(tx, order.map((name) => sweepOf(name, ran))));

      expect(result.sweepsRun).toEqual([n.missing, n.dueOld, n.neverRan, n.expiredLease]);
      expect(ran).toEqual(result.sweepsRun);
      expect(result.errors).toEqual([]);
      for (const name of [n.missing, n.dueOld, n.neverRan, n.expiredLease]) {
        const row = await schedule(tx, name);
        expect(row.last_run_at).not.toBeNull();
        expect(row.last_run_at).not.toBe(before[name]?.last_run_at);
        expect(row.lease_until).toBeNull(); // released after the run
        expect(row.last_error).toBeNull();
      }
      expect(await schedule(tx, n.notDue)).toEqual(before[n.notDue]);
      expect(await schedule(tx, n.leased)).toEqual(before[n.leased]);
    });
  });

  test("a throwing sweep is reported, keeps its error and frees its lease; later sweeps still run", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const ran: string[] = [];
      const bad: Sweep = { name: sweepName(), everyMs: 3_600_000, run: async () => { throw new Error("boom"); } };
      const good = sweepOf(sweepName(), ran);
      const result = await runTick(opts(tx, [bad, good]));
      expect(result.errors).toEqual([`sweep ${bad.name}: boom`]);
      expect(result.sweepsRun).toEqual([good.name]);
      const row = await schedule(tx, bad.name);
      expect(row.last_error).toBe("boom");
      expect(row.lease_until).toBeNull();
      expect(row.last_run_at).not.toBeNull();
    });
  });

  test("the lease handed to a sweep is the shorter of the budget and five minutes", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const name = sweepName();
      let lease: string | null = null;
      const sweep: Sweep = { name, everyMs: 3_600_000, run: async ({ db }) => void (lease = (await schedule(db as DbLike, name)).lease_until) };
      await runTick(opts(tx, [sweep], { budgetMs: 60_000 }));
      expect(lease).not.toBeNull();
      const [{ seconds }] = (await tx.execute(sql`select extract(epoch from (${lease}::timestamptz - now()))::int as seconds`)) as unknown as { seconds: number }[];
      expect(seconds).toBe(60);
    });
  });

  test("a deadline that arrives mid-tick does not burn the interval of sweeps that never ran", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const ran: string[] = [];
      // Runs until the tick's deadline has passed, so every later sweep must be skipped, not claimed.
      const slow: Sweep = {
        name: sweepName(),
        everyMs: 3_600_000,
        run: async (ctx) => {
          ran.push(slow.name);
          await new Promise((r) => setTimeout(r, Math.max(0, (ctx.deadline ?? 0) - Date.now()) + 25));
        },
      };
      const second = sweepOf(sweepName(), ran);
      const third = sweepOf(sweepName(), ran);
      await seed(tx, slow.name, { lastRun: HOURS_AGO_2 });
      await seed(tx, second.name, { lastRun: HOURS_AGO_2 });
      const secondBefore = await schedule(tx, second.name);

      const hb = heartbeatName();
      const result = await runTick(opts(tx, [slow, second, third], { budgetMs: 10_000, heartbeat: hb }));
      expect(result.sweepsRun).toEqual([slow.name]);
      expect(ran).toEqual([slow.name]);
      expect((await getTickHeartbeat(tx, hb)).lastRunAt).toBeInstanceOf(Date); // the deadline cut the tick short, the heartbeat still landed
      expect(await schedule(tx, second.name)).toEqual(secondBefore); // still due, still unleased
      const thirdRow = await schedule(tx, third.name);
      if (thirdRow) expect(thirdRow.last_run_at).toBeNull(); // at most seeded, never claimed
    });
  });

  test("a sweep that another tick claims after the due check is not run twice", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const ran: string[] = [];
      const contested = sweepOf(sweepName(), ran);
      const other = sweepOf(sweepName(), ran);
      await seed(tx, contested.name, { lastRun: HOURS_AGO_2 });
      await seed(tx, other.name, { lastRun: HOURS_AGO_2 });

      // After the 2nd statement of the tick (stale probe, then the due check) a competing tick claims `contested`.
      let calls = 0;
      const racing = new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "execute") return typeof value === "function" ? value.bind(target) : value;
          return async (...args: unknown[]) => {
            const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            if (++calls === 2) await target.execute(sql`update job_schedules set last_run_at = now(), lease_until = now() + interval '5 minutes' where name = ${contested.name}`);
            return out;
          };
        },
      }) as DbLike;

      const result = await runTick(opts(racing, [contested, other]));
      expect(result.sweepsRun).toEqual([other.name]);
      expect(ran).toEqual([other.name]);
    });
  });
});

describe("tick heartbeat", () => {
  const MIN_5 = sql`now() - interval '5 minutes'`;

  test("an idle tick writes it, as one extra statement", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const hb = heartbeatName();
      expect(await getTickHeartbeat(tx, hb)).toEqual({ lastRunAt: null, ageMs: null });
      const { result, queries } = await countQueries(() => runTick(opts(tx, [], { heartbeat: hb })));
      expect(result).toMatchObject({ sweepsRun: [], jobsRun: 0, tasksRun: 0, errors: [] }); // idle: nothing else happened
      expect(queries).toBe(2); // stale probe + heartbeat
      const beat = await getTickHeartbeat(tx, hb);
      expect(beat.lastRunAt).toBeInstanceOf(Date);
      expect(beat.ageMs).toBeLessThan(5_000);
      expect(await schedule(tx, hb)).toMatchObject({ lease_until: null, last_error: null });

      // Turned off: the statement is gone again.
      const off = await countQueries(() => runTick(opts(tx, [], { heartbeat: null })));
      expect(off.queries).toBe(1);
    });
  });

  test("a deadline-cut tick still writes it (budget already spent)", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const hb = heartbeatName();
      const ran: string[] = [];
      const result = await runTick(opts(tx, [sweepOf(sweepName(), ran)], { budgetMs: 0, heartbeat: hb }));
      expect(result.sweepsRun).toEqual([]); // the budget really did cut the tick short
      expect(ran).toEqual([]);
      expect((await getTickHeartbeat(tx, hb)).lastRunAt).toBeInstanceOf(Date);
    });
  });

  test("every tick advances it and records a short summary of its errors, or null", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const hb = heartbeatName();
      await tx.execute(sql`insert into job_schedules (name, last_run_at, last_error) values (${hb}, now() - interval '2 hours', 'stale error from long ago')`);
      expect((await getTickHeartbeat(tx, hb)).ageMs).toBeGreaterThan(2 * 3_600_000 - 5_000);

      const bad: Sweep = { name: sweepName(), everyMs: 3_600_000, run: async () => { throw new Error("boom"); } };
      const failed = await runTick(opts(tx, [bad], { heartbeat: hb }));
      expect(failed.errors).toEqual([`sweep ${bad.name}: boom`]);
      expect((await getTickHeartbeat(tx, hb)).ageMs).toBeLessThan(5_000); // advanced from 2 hours old
      expect((await schedule(tx, hb)).last_error).toBe(`1 error: sweep ${bad.name}: boom`);

      await runTick(opts(tx, [], { heartbeat: hb }));
      expect((await schedule(tx, hb)).last_error).toBeNull(); // a clean tick clears it
    });
  });

  test("the error summary is one capped line", () => {
    expect(summarizeTickErrors([])).toBeNull();
    expect(summarizeTickErrors(["a"])).toBe("1 error: a");
    expect(summarizeTickErrors(["a", "b"])).toBe("2 errors: a");
    expect(summarizeTickErrors(["x".repeat(5_000), "b"])?.length).toBe(300);
  });

  test("the persisted summary never holds bound query values", async () => {
    expect(summarizeTickErrors(["job 1 (publish): Failed query: update x set y = $1\nparams: victim@example.test"])).toBe("1 error: job 1 (publish): Failed query: update x set y = $1");
    await inRolledBackTx(async ({ tx }) => {
      const hb = heartbeatName();
      const leaky: Sweep = { name: sweepName(), everyMs: 3_600_000, run: async () => { throw new Error("Failed query: select 1 where a = $1\nparams: victim@example.test"); } };
      await runTick(opts(tx, [leaky], { heartbeat: hb }));
      const { last_error } = await schedule(tx, hb);
      expect(last_error).toContain("Failed query: select 1 where a = $1");
      expect(last_error).not.toContain("victim@example.test");
    });
  });

  test("writing it is one statement, whether the row is new or exists", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const hb = heartbeatName();
      expect((await countQueries(() => writeTickHeartbeat(tx, hb, []))).queries).toBe(1); // insert
      expect((await countQueries(() => writeTickHeartbeat(tx, hb, ["e"]))).queries).toBe(1); // update
      expect((await schedule(tx, hb)).last_error).toBe("1 error: e");
    });
  });

  test("the default name is tick.heartbeat (checked without touching the live row)", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const written: unknown[] = [];
      const recording = new Proxy(tx, {
        get(target, prop) {
          if (prop === "insert") return () => ({ values: (v: unknown) => ({ onConflictDoUpdate: async () => void written.push(v) }) });
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DbLike;
      await runTick({ db: recording, drain: false, sweeps: [], staleMs: NO_STALE_MS, jobFailedHooks: {} }); // no `heartbeat` option
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({ name: "tick.heartbeat" });
      expect(TICK_HEARTBEAT).toBe("tick.heartbeat");
    });
  });

  test("a failed heartbeat write is reported but does not fail the tick that did its work", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const failing = new Proxy(tx, {
        get(target, prop) {
          if (prop === "insert") return () => { throw new Error("heartbeat down"); };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DbLike;
      const result = await runTick(opts(failing, [])); // no sweeps: the heartbeat is the only insert
      expect(result.errors).toEqual(["heartbeat: heartbeat down"]);
      expect(result.recovered).toEqual({ jobs: 0, tasks: 0, failedJobs: 0 });
    });
  });

  test("getTickHeartbeat is one statement: null when never written, otherwise the database-clock age", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const hb = heartbeatName();
      const none = await countQueries(() => getTickHeartbeat(tx, hb));
      expect(none.queries).toBe(1);
      expect(none.result).toEqual({ lastRunAt: null, ageMs: null });

      await seed(tx, hb, { lastRun: MIN_5 });
      const some = await countQueries(() => getTickHeartbeat(tx, hb));
      expect(some.queries).toBe(1);
      expect(some.result.lastRunAt).toBeInstanceOf(Date);
      expect(some.result.ageMs).toBeGreaterThan(300_000 - 1_000);
      expect(some.result.ageMs).toBeLessThan(300_000 + 5_000);

      // a row that exists but never ran reads as "no heartbeat"
      const blank = heartbeatName();
      await seed(tx, blank, { lastRun: sql`null` });
      expect(await getTickHeartbeat(tx, blank)).toEqual({ lastRunAt: null, ageMs: null });
    });
  });

  describe("is never run as a sweep", () => {
    test("no registered sweep carries its name, and the digest cleanup patterns cannot match it", () => {
      expect(defaultSweeps.map((s) => s.name)).not.toContain(TICK_HEARTBEAT);
      expect(TICK_HEARTBEAT.startsWith("digest:")).toBe(false);
      expect(TICK_HEARTBEAT.startsWith("digest-week:")).toBe(false);
    });

    test("an old, unleased heartbeat row (looks due) is neither run, claimed nor leased by a tick; only the heartbeat write touches it", async () => {
      await inRolledBackTx(async ({ tx }) => {
        const hb = heartbeatName();
        await seed(tx, hb, { lastRun: HOURS_AGO_2 }); // exactly the shape of a due sweep
        const ran: string[] = [];
        const real = sweepOf(sweepName(), ran);
        const result = await runTick(opts(tx, [real], { heartbeat: null })); // heartbeat OFF: any change to the row would be a claim
        expect(result.sweepsRun).toEqual([real.name]);
        expect(ran).toEqual([real.name]);
        expect((await schedule(tx, hb)).lease_until).toBeNull();
        expect((await getTickHeartbeat(tx, hb)).ageMs).toBeGreaterThan(2 * 3_600_000 - 5_000); // not advanced: nothing claimed it

        // With the heartbeat on, the row is rewritten by the heartbeat only: still no lease, still not a sweep.
        const again = await runTick(opts(tx, [], { heartbeat: hb }));
        expect(again.sweepsRun).toEqual([]);
        expect((await schedule(tx, hb)).lease_until).toBeNull();
        expect((await getTickHeartbeat(tx, hb)).ageMs).toBeLessThan(5_000);
      });
    });
  });
});

describe("recoverStale", () => {
  // Cutoff = 1980: only the fixtures below (locked in 1975) are stale, never a real row of the shared database.
  const STALE_MS = Date.now() - Date.parse("1980-01-01T00:00:00Z");
  const LOCKED = new Date("1975-01-01T00:00:00Z");

  /** The pre-change implementation (two unconditional UPDATEs), kept to prove the new one is equivalent. */
  async function referenceRecoverStale(db: DbLike, staleMs: number) {
    const cutoff = new Date(Date.now() - staleMs).toISOString();
    const j = (await db.execute(sql`
      update jobs set
        status = case when attempts >= max_attempts then 'failed' else 'pending' end,
        error = coalesce(error, 'Worker timed out'),
        completed_at = case when attempts >= max_attempts then now() else completed_at end,
        locked_at = null, run_at = now(), updated_at = now()
      where status = 'processing' and locked_at < ${cutoff}::timestamptz
      returning *
    `)) as unknown as { id: string; status: string }[];
    const t = (await db.execute(sql`
      update tasks set
        status = case when attempts >= max_attempts then 'failed' else 'pending' end,
        last_error = coalesce(last_error, 'Worker timed out'),
        locked_at = null, run_at = now(), updated_at = now()
      where status = 'running' and locked_at < ${cutoff}::timestamptz
      returning id
    `)) as unknown as unknown[];
    return { jobs: j.length, tasks: t.length, failedJobs: j.filter((r) => r.status === "failed").map((r) => r.id) };
  }

  async function fixture(tx: DbLike, userId: string, withTasks = true) {
    const mk = async (over: Parameters<typeof mkJob>[3]) => (await mkJob(tx, userId, (await mkVideo(tx, userId)).id, { status: "processing", lockedAt: LOCKED, ...over })).id;
    const jobIds = {
      retry: await mk({ attempts: 1, maxAttempts: 3 }),
      exhausted: await mk({ attempts: 3, maxAttempts: 3 }),
      fresh: await mk({ attempts: 1, maxAttempts: 3, lockedAt: new Date() }), // locked just now: not stale
    };
    const mkTask = async (over: Partial<typeof tasks.$inferInsert>) => (await tx.insert(tasks).values({ kind: "__recover_test", status: "running", lockedAt: LOCKED, ...over }).returning({ id: tasks.id }))[0].id;
    const taskIds = withTasks
      ? { retry: await mkTask({ attempts: 1, maxAttempts: 3 }), exhausted: await mkTask({ attempts: 3, maxAttempts: 3 }), fresh: await mkTask({ lockedAt: new Date() }) }
      : null;
    return { jobIds, taskIds };
  }

  async function snapshot(tx: DbLike, ids: Awaited<ReturnType<typeof fixture>>) {
    const out: Record<string, unknown> = {};
    for (const [role, id] of Object.entries(ids.jobIds)) {
      const [r] = (await tx.execute(sql`select status, error, attempts, completed_at is not null as completed, locked_at is not null as locked, run_at <= now() as runnable from jobs where id = ${id}`)) as unknown as unknown[];
      out[`job.${role}`] = r;
    }
    for (const [role, id] of Object.entries(ids.taskIds ?? {})) {
      const [r] = (await tx.execute(sql`select status, last_error, attempts, locked_at is not null as locked, run_at <= now() as runnable from tasks where id = ${id}`)) as unknown as unknown[];
      out[`task.${role}`] = r;
    }
    return out;
  }

  test("idle costs one statement and changes nothing", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const { result, queries } = await countQueries(() => recoverStale(tx, NO_STALE_MS));
      expect(queries).toBe(1);
      expect(result).toEqual({ jobs: 0, tasks: 0, failedJobs: [] });
    });
  });

  test("recovers exactly what the two unconditional UPDATEs did (same counts, same row states), and skips a table with nothing stale", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const a = await fixture(tx, user.id);
      const mine = await countQueries(() => recoverStale(tx, STALE_MS));
      expect(mine.queries).toBe(3); // probe + jobs + tasks
      const snapA = await snapshot(tx, a);

      const b = await fixture(tx, user.id);
      const theirs = await referenceRecoverStale(tx, STALE_MS);
      const snapB = await snapshot(tx, b);

      expect({ jobs: mine.result.jobs, tasks: mine.result.tasks, failed: mine.result.failedJobs.length }).toEqual({ jobs: 2, tasks: 2, failed: 1 });
      expect({ jobs: theirs.jobs, tasks: theirs.tasks, failed: theirs.failedJobs.length }).toEqual({ jobs: 2, tasks: 2, failed: 1 });
      expect(mine.result.failedJobs.map((j) => j.id)).toEqual([a.jobIds.exhausted]);
      expect(mine.result.failedJobs[0]).toMatchObject({ status: "failed", error: "Worker timed out", attempts: 3 });
      expect(mine.result.failedJobs[0].lockedAt).toBeNull();
      expect(mine.result.failedJobs[0].completedAt).toBeInstanceOf(Date);
      expect(snapA).toEqual(snapB);
      expect(snapA["job.retry"]).toMatchObject({ status: "pending", locked: false });
      expect(snapA["job.exhausted"]).toMatchObject({ status: "failed", completed: true, locked: false });
      expect(snapA["job.fresh"]).toMatchObject({ status: "processing", locked: true });
      expect(snapA["task.retry"]).toMatchObject({ status: "pending", last_error: "Worker timed out" });
      expect(snapA["task.exhausted"]).toMatchObject({ status: "failed", last_error: "Worker timed out" });
      expect(snapA["task.fresh"]).toMatchObject({ status: "running", locked: true });

      // Only jobs stale: the tasks UPDATE is skipped (probe + jobs UPDATE).
      await fixture(tx, user.id, false);
      const jobsOnly = await countQueries(() => recoverStale(tx, STALE_MS));
      expect(jobsOnly.queries).toBe(2);
      expect(jobsOnly.result).toMatchObject({ jobs: 2, tasks: 0 });
      // Nothing stale any more: back to the single probe.
      expect((await countQueries(() => recoverStale(tx, STALE_MS))).queries).toBe(1);
    });
  });
});
