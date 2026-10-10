/**
 * What the job runner's tables say about its health (scaling ladder M-3, M-4). One reader per question, each ONE
 * statement, shared by `/api/health` (behind the cron secret) and the admin health page, so both always mean the
 * same thing by "pending" and "stale".
 *
 * Every age is computed by the database (`now()`), like the tick heartbeat, so the app server's clock never matters.
 */
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import type { QueueScope } from "@/server/jobs/queue";

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
  const jobs = toCounts(row, "j");
  const tasks = toCounts(row, "t");
  const ages = [jobs.oldestPendingAgeMs, tasks.oldestPendingAgeMs].filter((a): a is number => a !== null);
  return { jobs, tasks, oldestPendingAgeMs: ages.length ? Math.max(...ages) : null };
}
