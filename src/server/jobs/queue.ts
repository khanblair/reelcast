/**
 * Portable Postgres job queue (replaces Convex scheduler.runAfter/runAt/cancel).
 *
 * Two queues share one design:
 *   jobs   user-visible work tied to a video ("publish", "generation"); shown in History.
 *   tasks  internal steps (Veo polling, scheduled metadata, digests, ...), no UI.
 *
 * Guarantees
 *  - Claiming uses FOR UPDATE SKIP LOCKED, so concurrent ticks never run the same row.
 *  - At-least-once: a crashed worker's row is recovered after `staleMs` (recoverStale).
 *    Handlers MUST be idempotent (check state first; record external ids before marking done).
 *  - Enqueue is atomic with the caller's transaction (pass `tx`), which is the Postgres
 *    equivalent of calling scheduler.runAfter inside a Convex mutation.
 *  - `jobs` is unique per (video, type) while pending/processing, so a double-click,
 *    a retry, and the scheduled-publish sweep can never create two publishes.
 *  - `tasks.dedupe_key` replaces Convex scheduler ids: enqueue with a key to make a task
 *    unique while pending/running; cancel by key.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { jobs, tasks } from "@/db/schema";

export type JobRow = typeof jobs.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type JobType = JobRow["type"];

/** Exponential backoff: 30s, 60s, 120s ... capped at 15 min. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 15 * 60_000);
}

// ─── jobs ────────────────────────────────────────────────────────────────────

export type EnqueueJobInput = {
  userId: string;
  videoId: string;
  type: JobType;
  runAt?: Date;
  metadata?: unknown;
  maxAttempts?: number;
};

/**
 * Create a pending job, or return the already-active one for this (video, type).
 * `created` tells the caller which happened.
 */
export async function enqueueJob(db: DbLike, input: EnqueueJobInput): Promise<{ job: JobRow; created: boolean }> {
  const [inserted] = await db
    .insert(jobs)
    .values({
      userId: input.userId,
      videoId: input.videoId,
      type: input.type,
      runAt: input.runAt ?? new Date(),
      metadata: input.metadata ?? null,
      maxAttempts: input.maxAttempts ?? 3,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { job: inserted, created: true };

  const [existing] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.videoId, input.videoId), eq(jobs.type, input.type), inArray(jobs.status, ["pending", "processing"])))
    .limit(1);
  if (!existing) throw new Error("enqueueJob: conflict but no active job found");
  return { job: existing, created: false };
}

/** Claim up to `limit` due jobs for this worker. */
export async function claimJobs(db: DbLike, limit: number, types?: JobType[]): Promise<JobRow[]> {
  const typeFilter = types?.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const rows = (await db.execute(sql`
    update jobs set
      status = 'processing',
      locked_at = now(),
      attempts = attempts + 1,
      started_at = coalesce(started_at, now()),
      updated_at = now()
    where id in (
      select id from jobs
      where status = 'pending' and run_at <= now() ${typeFilter}
      order by run_at
      for update skip locked
      limit ${limit}
    )
    returning *
  `)) as unknown as Record<string, unknown>[];
  return rows.map(camelRow) as JobRow[];
}

export async function completeJob(db: DbLike, id: string, metadata?: unknown): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "completed", completedAt: new Date(), lockedAt: null, error: null, updatedAt: new Date(), ...(metadata !== undefined ? { metadata } : {}) })
    .where(eq(jobs.id, id));
}

/**
 * Record a failure. Retryable errors go back to pending with backoff until maxAttempts;
 * otherwise the job is failed for good. Returns the resulting status.
 */
export async function failJob(db: DbLike, job: Pick<JobRow, "id" | "attempts" | "maxAttempts">, error: string, opts: { retryable?: boolean } = {}): Promise<"pending" | "failed"> {
  const retry = (opts.retryable ?? true) && job.attempts < job.maxAttempts;
  if (retry) {
    await db
      .update(jobs)
      .set({ status: "pending", error, lockedAt: null, runAt: new Date(Date.now() + backoffMs(job.attempts)), updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    return "pending";
  }
  await db.update(jobs).set({ status: "failed", error, completedAt: new Date(), lockedAt: null, updatedAt: new Date() }).where(eq(jobs.id, job.id));
  return "failed";
}

/**
 * Not finished yet: put the job back to pending to run again after `delayMs`, WITHOUT
 * consuming a retry attempt (long operations resume across ticks: Veo polling, chunked uploads).
 * `metadata` (resume state) is replaced when given.
 */
export async function deferJob(db: DbLike, job: Pick<JobRow, "id">, delayMs: number, metadata?: unknown): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: "pending",
      lockedAt: null,
      runAt: new Date(Date.now() + delayMs),
      attempts: sql`greatest(${jobs.attempts} - 1, 0)`,
      updatedAt: new Date(),
      ...(metadata !== undefined ? { metadata } : {}),
    })
    .where(eq(jobs.id, job.id));
}

/** Re-queue a failed job for a manual retry (user pressed "Retry"). */
export async function requeueJob(db: DbLike, id: string): Promise<JobRow | null> {
  const [row] = await db
    .update(jobs)
    .set({ status: "pending", error: null, startedAt: null, completedAt: null, lockedAt: null, attempts: 0, runAt: new Date(), updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "failed")))
    .returning();
  return row ?? null;
}

// ─── tasks ───────────────────────────────────────────────────────────────────

export type EnqueueTaskInput = {
  kind: string;
  payload?: Record<string, unknown>;
  userId?: string;
  runAt?: Date;
  /** While a pending/running task has this key, enqueueing again is a no-op. */
  dedupeKey?: string;
  maxAttempts?: number;
};

export async function enqueueTask(db: DbLike, input: EnqueueTaskInput): Promise<{ task: TaskRow; created: boolean }> {
  const [inserted] = await db
    .insert(tasks)
    .values({
      kind: input.kind,
      payload: input.payload ?? {},
      userId: input.userId ?? null,
      runAt: input.runAt ?? new Date(),
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? 3,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { task: inserted, created: true };
  if (!input.dedupeKey) throw new Error("enqueueTask: unexpected conflict");
  const [existing] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.dedupeKey, input.dedupeKey), inArray(tasks.status, ["pending", "running"])))
    .limit(1);
  if (!existing) throw new Error("enqueueTask: conflict but no active task found");
  return { task: existing, created: false };
}

/** Cancel a still-pending task by key (replaces ctx.scheduler.cancel). Returns true if one was cancelled. */
export async function cancelTask(db: DbLike, dedupeKey: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(tasks.dedupeKey, dedupeKey), eq(tasks.status, "pending")))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export async function claimTasks(db: DbLike, limit: number, kinds?: string[]): Promise<TaskRow[]> {
  const kindFilter = kinds?.length ? sql`and kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  const rows = (await db.execute(sql`
    update tasks set
      status = 'running',
      locked_at = now(),
      attempts = attempts + 1,
      updated_at = now()
    where id in (
      select id from tasks
      where status = 'pending' and run_at <= now() ${kindFilter}
      order by run_at
      for update skip locked
      limit ${limit}
    )
    returning *
  `)) as unknown as Record<string, unknown>[];
  return rows.map(camelRow) as TaskRow[];
}

export async function completeTask(db: DbLike, id: string): Promise<void> {
  await db.update(tasks).set({ status: "done", lockedAt: null, lastError: null, updatedAt: new Date() }).where(eq(tasks.id, id));
}

export async function failTask(db: DbLike, task: Pick<TaskRow, "id" | "attempts" | "maxAttempts">, error: string, opts: { retryable?: boolean; retryInMs?: number } = {}): Promise<"pending" | "failed"> {
  const retry = (opts.retryable ?? true) && task.attempts < task.maxAttempts;
  if (retry) {
    await db
      .update(tasks)
      .set({ status: "pending", lastError: error, lockedAt: null, runAt: new Date(Date.now() + (opts.retryInMs ?? backoffMs(task.attempts))), updatedAt: new Date() })
      .where(eq(tasks.id, task.id));
    return "pending";
  }
  await db.update(tasks).set({ status: "failed", lastError: error, lockedAt: null, updatedAt: new Date() }).where(eq(tasks.id, task.id));
  return "failed";
}

/** Reschedule a running task to run again later without counting a failure (polling loops). */
export async function rescheduleTask(db: DbLike, id: string, delayMs: number, payload?: Record<string, unknown>): Promise<void> {
  await db
    .update(tasks)
    .set({ status: "pending", lockedAt: null, runAt: new Date(Date.now() + delayMs), attempts: 0, updatedAt: new Date(), ...(payload ? { payload } : {}) })
    .where(eq(tasks.id, id));
}

// ─── recovery ────────────────────────────────────────────────────────────────

/**
 * Rows stuck in processing/running (worker crashed or timed out) go back to pending, or to
 * failed once attempts are exhausted. Returns how many were recovered.
 *
 * Nothing is stuck on almost every call, so ONE read-only probe asks whether any row of either
 * table is stale and the UPDATEs run only for the table(s) that have some (idle cost: 1 statement
 * instead of 2). The UPDATEs are unchanged and re-check the same predicate, so a row that stopped
 * being stale between the probe and the UPDATE is still left alone; a row that turned stale after
 * the probe is recovered by the next call. The probe takes no row locks, and the two tables are
 * still updated by separate statements, so no transaction ever holds a jobs lock while waiting
 * on a tasks lock (or the other way round).
 */
export async function recoverStale(db: DbLike, staleMs: number): Promise<{ jobs: number; tasks: number; failedJobs: JobRow[] }> {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const [probe] = (await db.execute(sql`
    select
      exists (select 1 from jobs where status = 'processing' and locked_at < ${cutoff}::timestamptz) as jobs,
      exists (select 1 from tasks where status = 'running' and locked_at < ${cutoff}::timestamptz) as tasks
  `)) as unknown as { jobs: boolean; tasks: boolean }[];
  const j = !probe.jobs
    ? []
    : ((await db.execute(sql`
        update jobs set
          status = case when attempts >= max_attempts then 'failed' else 'pending' end,
          error = coalesce(error, 'Worker timed out'),
          completed_at = case when attempts >= max_attempts then now() else completed_at end,
          locked_at = null, run_at = now(), updated_at = now()
        where status = 'processing' and locked_at < ${cutoff}::timestamptz
        returning *
      `)) as unknown as Record<string, unknown>[]);
  const t = !probe.tasks
    ? []
    : ((await db.execute(sql`
        update tasks set
          status = case when attempts >= max_attempts then 'failed' else 'pending' end,
          last_error = coalesce(last_error, 'Worker timed out'),
          locked_at = null, run_at = now(), updated_at = now()
        where status = 'running' and locked_at < ${cutoff}::timestamptz
        returning id
      `)) as unknown as unknown[]);
  const failedJobs = j.map(camelRow).filter((r) => r.status === "failed") as JobRow[];
  return { jobs: j.length, tasks: t.length, failedJobs };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const DATE_COLS = new Set(["runAt", "lockedAt", "startedAt", "completedAt", "createdAt", "updatedAt"]);

/** Raw `db.execute` rows are snake_case with string timestamps; map them to the Drizzle row shape. */
function camelRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = camel(k);
    out[key] = DATE_COLS.has(key) && typeof v === "string" ? new Date(v) : v;
  }
  return out;
}
