/**
 * The job runner. One call = one "tick": recover stuck work, run due sweeps, then drain
 * due jobs and tasks until the time budget is spent. Safe to run concurrently from many
 * callers (pg_cron hitting /api/cron/tick, the dev interval, a post-enqueue kick).
 */
import { sql } from "drizzle-orm";
import { db as defaultDb, type DbLike } from "@/db/client";
import { jobSchedules } from "@/db/schema";
import { TICK_HEARTBEAT, writeTickHeartbeat } from "./heartbeat";
import { NonRetryableError, jobFailedHooks as defaultHooks, jobHandlers, sweeps as defaultSweeps, taskHandlers, type HandlerCtx, type JobFailedHook, type Sweep } from "./handlers";
import { claimJobs, claimTasks, completeJob, completeTask, deferJob, failJob, failTask, recoverStale, rescheduleTask, type JobRow, type QueueScope, type TaskRow } from "./queue";

export type TickOptions = {
  db?: DbLike;
  /** Stop starting new work after this many ms (leave headroom under the host's function limit). */
  budgetMs?: number;
  /** Max handlers running at once within this tick. */
  concurrency?: number;
  /** Rows stuck in processing/running longer than this are recovered. */
  staleMs?: number;
  sweeps?: Sweep[];
  /** Set false to skip claiming/running jobs and tasks (recovery + sweeps only). Tests use it. */
  drain?: boolean;
  /** Override the registered job-failed hooks (tests). */
  jobFailedHooks?: Partial<Record<JobRow["type"], JobFailedHook>>;
  /** Tests only: recover and claim ONLY this user's rows (see QueueScope). Production never sets it. */
  scope?: QueueScope;
  /**
   * Name of the `job_schedules` row that records "a tick finished" (default `tick.heartbeat`), or null to write none.
   * Anything that runs ticks against the shared database for a reason other than production scheduling (tests that use
   * the real db, a developer's ticker) should pass its own name or null, so it cannot make a dead production tick look alive.
   */
  heartbeat?: string | null;
};

export type TickResult = { recovered: { jobs: number; tasks: number; failedJobs: number }; sweepsRun: string[]; jobsRun: number; tasksRun: number; errors: string[] };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isRetryable = (e: unknown) => !(e instanceof NonRetryableError);

/**
 * Which of `sweeps` need a claim attempt right now, in ONE statement: those with no schedule row yet
 * (`missing`) and those whose interval has elapsed with no live lease (the same predicate as the claim
 * UPDATE below). On an idle tick it returns nothing, so the whole sweep phase costs one statement
 * instead of two per sweep. It is only a filter: ownership is still decided by `claimSweep`.
 */
async function dueSweeps(db: DbLike, sweeps: Sweep[]): Promise<{ due: Set<string>; missing: string[] }> {
  const rows = (await db.execute(sql`
    select v.name, (s.name is null) as missing
      from (values ${sql.join(sweeps.map((s) => sql`(${s.name}::text, ${s.everyMs}::float8)`), sql`, `)}) as v(name, every_ms)
      left join job_schedules s on s.name = v.name
     where s.name is null
        or ((s.last_run_at is null or s.last_run_at <= now() - v.every_ms * interval '1 millisecond')
            and (s.lease_until is null or s.lease_until <= now()))
  `)) as unknown as { name: string; missing: boolean }[];
  return { due: new Set(rows.map((r) => r.name)), missing: [...new Set(rows.filter((r) => r.missing).map((r) => r.name))] };
}

/** Atomically claim a sweep: only the tick that advances last_run_at runs it. The schedule row must exist. */
async function claimSweep(db: DbLike, name: string, everyMs: number, leaseMs: number): Promise<boolean> {
  const rows = (await db.execute(sql`
    update job_schedules
       set last_run_at = now(), lease_until = now() + ${leaseMs} * interval '1 millisecond'
     where name = ${name}
       and (last_run_at is null or last_run_at <= now() - ${everyMs} * interval '1 millisecond')
       and (lease_until is null or lease_until <= now())
    returning name
  `)) as unknown as unknown[];
  return rows.length > 0;
}

async function notifyFailed(hooks: Partial<Record<JobRow["type"], JobFailedHook>>, job: JobRow, error: string, ctx: HandlerCtx, errors: string[]) {
  const hook = hooks[job.type];
  if (!hook) return;
  try {
    await hook(job, error, ctx);
  } catch (e) {
    errors.push(`onJobFailed ${job.id} (${job.type}): ${msg(e)}`);
  }
}

async function runJob(db: DbLike, job: JobRow, ctx: HandlerCtx, errors: string[], hooks: Partial<Record<JobRow["type"], JobFailedHook>>) {
  const handler = jobHandlers[job.type];
  if (!handler) {
    const err = `No handler registered for job type "${job.type}"`;
    await failJob(db, job, err, { retryable: false });
    await notifyFailed(hooks, job, err, ctx, errors);
    return;
  }
  try {
    const out = await handler(job, ctx);
    if (out && "deferMs" in out) await deferJob(db, job, out.deferMs, out.metadata);
    else await completeJob(db, job.id, out && "metadata" in out ? out.metadata : undefined);
  } catch (e) {
    errors.push(`job ${job.id} (${job.type}): ${msg(e)}`);
    const status = await failJob(db, job, msg(e), { retryable: isRetryable(e) });
    if (status === "failed") await notifyFailed(hooks, job, msg(e), ctx, errors);
  }
}

async function runTask(db: DbLike, task: TaskRow, ctx: HandlerCtx, errors: string[]) {
  const handler = taskHandlers[task.kind];
  if (!handler) {
    await failTask(db, task, `No handler registered for task kind "${task.kind}"`, { retryable: false });
    return;
  }
  try {
    const out = await handler(task, ctx);
    if (out && "rescheduleInMs" in out) await rescheduleTask(db, task.id, out.rescheduleInMs, out.payload);
    else await completeTask(db, task.id);
  } catch (e) {
    errors.push(`task ${task.id} (${task.kind}): ${msg(e)}`);
    await failTask(db, task, msg(e), { retryable: isRetryable(e) });
  }
}

export async function runTick(opts: TickOptions = {}): Promise<TickResult> {
  const db = opts.db ?? defaultDb;
  const budgetMs = opts.budgetMs ?? 240_000;
  const concurrency = opts.concurrency ?? 3;
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const sweeps = opts.sweeps ?? defaultSweeps;
  const deadline = Date.now() + budgetMs;
  const hooks = opts.jobFailedHooks ?? defaultHooks;
  const result: TickResult = { recovered: { jobs: 0, tasks: 0, failedJobs: 0 }, sweepsRun: [], jobsRun: 0, tasksRun: 0, errors: [] };

  const recovered = await recoverStale(db, staleMs, opts.scope);
  result.recovered = { jobs: recovered.jobs, tasks: recovered.tasks, failedJobs: recovered.failedJobs.length };
  for (const job of recovered.failedJobs) await notifyFailed(hooks, job, job.error ?? "Worker timed out", { db, now: new Date() }, result.errors);

  // One cheap check finds the sweeps that are due (almost always none). Each due sweep is still claimed
  // one at a time, right before it runs and after the deadline check: claiming them all up front would
  // burn the interval (up to 6 hours) of every sweep that a deadline break or a crash kept from running.
  const { due, missing } = sweeps.length > 0 && Date.now() < deadline ? await dueSweeps(db, sweeps) : { due: new Set<string>(), missing: [] as string[] };
  if (missing.length > 0 && Date.now() < deadline) await db.insert(jobSchedules).values(missing.map((name) => ({ name }))).onConflictDoNothing();

  for (const sweep of sweeps) {
    if (Date.now() >= deadline) break;
    if (!due.has(sweep.name)) continue;
    if (!(await claimSweep(db, sweep.name, sweep.everyMs, Math.min(budgetMs, 5 * 60_000)))) continue;
    try {
      await sweep.run({ db, now: new Date(), deadline });
      result.sweepsRun.push(sweep.name);
      await db.execute(sql`update job_schedules set lease_until = null, last_error = null where name = ${sweep.name}`);
    } catch (e) {
      result.errors.push(`sweep ${sweep.name}: ${msg(e)}`);
      await db.execute(sql`update job_schedules set lease_until = null, last_error = ${msg(e)}, last_run_at = now() where name = ${sweep.name}`);
    }
  }

  // Drain: claim small batches until nothing is due or the budget is spent.
  while (opts.drain !== false && Date.now() < deadline) {
    const [js, ts] = await Promise.all([claimJobs(db, concurrency, undefined, opts.scope), claimTasks(db, concurrency, undefined, opts.scope)]);
    if (js.length === 0 && ts.length === 0) break;
    const ctx: HandlerCtx = { db, now: new Date(), deadline };
    await Promise.all([
      ...js.map((j) => runJob(db, j, ctx, result.errors, hooks).then(() => void result.jobsRun++)),
      ...ts.map((t) => runTask(db, t, ctx, result.errors).then(() => void result.tasksRun++)),
    ]);
  }

  // The last thing every tick does, idle or cut short by the deadline, but not in a `finally`: a tick that threw above
  // must leave the heartbeat stale. One statement. A failed write is reported, it must not fail a tick that did its work.
  const heartbeat = opts.heartbeat === undefined ? TICK_HEARTBEAT : opts.heartbeat;
  if (heartbeat !== null) {
    try {
      await writeTickHeartbeat(db, heartbeat, result.errors);
    } catch (e) {
      result.errors.push(`heartbeat: ${msg(e)}`.slice(0, 300));
    }
  }
  return result;
}
