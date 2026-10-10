/**
 * What the job runner's tables say about its health (scaling ladder M-3, M-4). One reader per question, each ONE
 * statement, shared by `/api/health` (behind the cron secret) and the admin health page, so both always mean the
 * same thing by "pending" and "stale".
 *
 * Every age is computed by the database (`now()`), like the tick heartbeat, so the app server's clock never matters.
 */
import { and, desc, eq, isNotNull, notLike, or, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { jobSchedules, tasks } from "@/db/schema";
import { TICK_HEARTBEAT } from "@/server/jobs/heartbeat";
import type { QueueScope } from "@/server/jobs/queue";
import { stripQueryParams } from "./safe-error";

/** pg_cron ticks every minute; a heartbeat older than this means the scheduler (or the route) has stopped. */
export const TICK_STALE_MS = 3 * 60_000;

/** How far back "failed recently" looks. Also written as the literal in the SQL below. */
export const FAILED_WINDOW_HOURS = 24;

export type QueueCounts = {
  /** Due now: status 'pending' and run_at <= now(). Work that is waiting for a runner. */
  pending: number;
  /**
   * Pending but not due yet: a scheduled run (digests, auto-publish, metadata schedules) or a retry backoff. This is
   * normal and is NOT backlog, so it is kept out of `pending` and out of `oldestPendingAgeMs`.
   */
  scheduled: number;
  /** Being worked on: jobs with status 'processing', tasks with status 'running'. */
  processing: number;
  /** Failed with `updated_at` inside the last FAILED_WINDOW_HOURS. */
  failedLast24h: number;
  /** How long the oldest DUE pending row has been waiting, measured from its run_at; null when nothing is due. */
  oldestPendingAgeMs: number | null;
};

export type QueueDepth = {
  jobs: QueueCounts;
  tasks: QueueCounts;
  /** The larger of the two oldest-pending ages, or null when nothing is due. */
  oldestPendingAgeMs: number | null;
};

type DepthRow = Record<string, number | null>;

/** The same numbers for one table. `processing` is the status that table uses for "being worked on". */
function countsOf(table: "jobs" | "tasks", processing: "processing" | "running", scope: QueueScope | undefined) {
  if (scope !== undefined && (typeof scope.userId !== "string" || scope.userId === "")) throw new Error("queue scope requires a non-empty userId");
  const only = scope ? sql`and user_id = ${scope.userId}` : sql``;
  return sql`(
    select
      (count(*) filter (where status = 'pending' and run_at <= now()))::int as pending,
      (count(*) filter (where status = 'pending' and run_at > now()))::int as scheduled,
      (count(*) filter (where status = ${sql.raw(`'${processing}'`)}))::int as processing,
      (count(*) filter (where status = 'failed'))::int as failed,
      (extract(epoch from (now() - min(run_at) filter (where status = 'pending' and run_at <= now()))) * 1000)::float8 as oldest_ms
    from ${sql.identifier(table)}
    where (status in ('pending', ${sql.raw(`'${processing}'`)}) or (status = 'failed' and updated_at > now() - interval '24 hours')) ${only}
  )`;
}

const toCounts = (r: DepthRow, p: "j" | "t"): QueueCounts => ({
  pending: Number(r[`${p}_pending`] ?? 0),
  scheduled: Number(r[`${p}_scheduled`] ?? 0),
  processing: Number(r[`${p}_processing`] ?? 0),
  failedLast24h: Number(r[`${p}_failed`] ?? 0),
  oldestPendingAgeMs: r[`${p}_oldest_ms`] == null ? null : Math.round(Number(r[`${p}_oldest_ms`])),
});

/**
 * Queue depth for jobs and tasks in ONE statement (two aggregates side by side; an aggregate with no GROUP BY always
 * returns one row, so an empty queue still answers). The WHERE keeps it to the rows that matter: not-finished work and
 * recent failures, never the history of completed rows.
 *
 * `scope` is for tests that share a database with real data (same meaning as in queue.ts): count only that user's rows.
 */
export async function getQueueDepth(db: DbLike, scope?: QueueScope): Promise<QueueDepth> {
  const rows = (await db.execute(sql`
    select
      j.pending as j_pending, j.scheduled as j_scheduled, j.processing as j_processing, j.failed as j_failed, j.oldest_ms as j_oldest_ms,
      t.pending as t_pending, t.scheduled as t_scheduled, t.processing as t_processing, t.failed as t_failed, t.oldest_ms as t_oldest_ms
    from ${countsOf("jobs", "processing", scope)} j, ${countsOf("tasks", "running", scope)} t
  `)) as unknown as DepthRow[];
  const row = rows[0] ?? {};
  const jobCounts = toCounts(row, "j");
  const taskCounts = toCounts(row, "t");
  const ages = [jobCounts.oldestPendingAgeMs, taskCounts.oldestPendingAgeMs].filter((a): a is number => a !== null);
  return { jobs: jobCounts, tasks: taskCounts, oldestPendingAgeMs: ages.length ? Math.max(...ages) : null };
}

// ─── failed tasks and sweep errors (admin only: they carry error text) ───────────────────────────────────────────────

const MAX_ERROR_CHARS = 300;

/**
 * An error text that is safe to show an admin: a Drizzle "Failed query" message is cut before its `params:` line (the
 * bound values are user data), then the text is truncated. Null stays null.
 */
export function scrubError(text: string | null): string | null {
  return text === null ? null : stripQueryParams(text).slice(0, MAX_ERROR_CHARS);
}

export type FailedTask = { id: string; kind: string; attempts: number; maxAttempts: number; lastError: string | null; failedAt: Date };

/**
 * The most recent permanently failed tasks, newest first (ONE statement). Tasks have no UI, so before this nobody saw
 * them fail. The payload is deliberately not selected: it can hold user data.
 */
export async function getFailedTasks(db: DbLike, limit = 20, scope?: QueueScope): Promise<FailedTask[]> {
  if (scope !== undefined && (typeof scope.userId !== "string" || scope.userId === "")) throw new Error("queue scope requires a non-empty userId");
  const rows = await db
    .select({ id: tasks.id, kind: tasks.kind, attempts: tasks.attempts, maxAttempts: tasks.maxAttempts, lastError: tasks.lastError, failedAt: tasks.updatedAt })
    .from(tasks)
    .where(and(eq(tasks.status, "failed"), scope ? eq(tasks.userId, scope.userId) : undefined))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, lastError: scrubError(r.lastError) }));
}

/** At most this many erroring sweeps are listed (there are a handful of sweeps in total). */
export const SCHEDULE_ERROR_LIMIT = 50;

export type TickState = {
  /** When the last production tick finished, or null if none was ever recorded (normal in dev: only the cron route writes it). */
  lastRunAt: Date | null;
  ageMs: number | null;
  /** The heartbeat exists and is older than TICK_STALE_MS: the scheduler has stopped. */
  stale: boolean;
  /** The last tick's own error summary, if it had errors. */
  lastError: string | null;
};
export type ScheduleError = { name: string; lastRunAt: Date | null; lastError: string };
export type ScheduleHealth = { tick: TickState; scheduleErrors: ScheduleError[] };

/**
 * The tick heartbeat and every sweep whose last run failed, in ONE statement over `job_schedules`.
 *
 * A sweep clears its `last_error` when it next succeeds (tick.ts), so a row listed here is failing NOW. Left out: the
 * heartbeat row itself (its state is `tick`), and the `digest:` / `digest-week:` marker rows, which are bookkeeping
 * and not sweeps. `heartbeatName` is for tests, which use a row of their own.
 */
export async function getScheduleHealth(db: DbLike, heartbeatName: string = TICK_HEARTBEAT): Promise<ScheduleHealth> {
  const rows = await db
    .select({
      name: jobSchedules.name,
      lastRunAt: jobSchedules.lastRunAt,
      lastError: jobSchedules.lastError,
      ageMs: sql<number | null>`(extract(epoch from (now() - ${jobSchedules.lastRunAt})) * 1000)::float8`,
    })
    .from(jobSchedules)
    .where(
      or(
        eq(jobSchedules.name, heartbeatName),
        and(isNotNull(jobSchedules.lastError), notLike(jobSchedules.name, "digest:%"), notLike(jobSchedules.name, "digest-week:%")),
      ),
    )
    .orderBy(sql`(${jobSchedules.name} = ${heartbeatName}) desc`, jobSchedules.name)
    .limit(SCHEDULE_ERROR_LIMIT + 1);

  const beat = rows.find((r) => r.name === heartbeatName);
  const ageMs = beat?.lastRunAt && beat.ageMs !== null ? Math.round(Number(beat.ageMs)) : null;
  return {
    tick: { lastRunAt: beat?.lastRunAt ?? null, ageMs, stale: ageMs !== null && ageMs > TICK_STALE_MS, lastError: scrubError(beat?.lastError ?? null) },
    scheduleErrors: rows.flatMap((r) => (r.name !== heartbeatName && r.lastError !== null ? [{ name: r.name, lastRunAt: r.lastRunAt, lastError: scrubError(r.lastError) ?? "" }] : [])),
  };
}
