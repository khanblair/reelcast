/**
 * Retention: delete rows nobody reads any more, in bounded batches, so the tables that only ever grow stop growing.
 * Runs as the `maintenance.retention` sweep (every 6 hours, src/server/jobs/handlers/system.ts).
 *
 *   tasks                done / failed / cancelled and last touched > 14 days ago
 *   notifications        READ and created > 90 days ago (unread ones are never deleted)
 *   youtube_quota_usage  rows for a UTC day > 90 days ago (only today's row is ever read or written)
 *   payment_events       unmatched ones the 5-minute purge missed (see purgeUnmatchedEvents in billing/core.ts)
 *
 * Why these are safe to delete (checked in the code, not assumed):
 *  - tasks: every reader of the table looks at pending/running rows only. The dedupe key is unique only among
 *    pending/running rows (partial index tasks_dedupe_idx), so `enqueueTask` / `cancelTask` never see a finished row.
 *    Auto-publish and the digest batch re-pend their OWN row instead of reading old ones; analytics continuations
 *    carry their cursor in the new row's payload; the digest's "once per week" markers live in job_schedules, not here.
 *    The only other statements on tasks are the claim, the stale recovery and the two "cancel pending tasks for a deleted
 *    video / account" updates, all of which filter on a live status.
 *  - notifications: only read ones. The only reader (modules/notifications.ts) lists the 50 newest per user, so a user with
 *    fewer than 50 sees a read notification disappear from the bell after 90 days; that is the point.
 *  - youtube_quota_usage: `getYoutubeQuotaUsed`, `addYoutubeQuota` and the admin quota page use today's row only.
 * Nothing here touches subscriptions, payment_orders or matched payment_events: those are the billing audit trail.
 *
 * Each delete is ONE statement that takes at most RETENTION_BATCH rows with `FOR UPDATE SKIP LOCKED`: it is idempotent
 * (a second run finds nothing more to take) and two runs at once take disjoint rows. A backlog larger than one batch is
 * worked off over the next runs. Cut-offs come from the `now` the sweep is given (never SQL `now()`), so a test can
 * choose its own clock.
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { purgeUnmatchedEvents } from "@/server/billing/core";
import { safeErrorMessage } from "@/server/lib/safe-error";
import { utcDateString } from "@/server/lib/youtubeQuota";

const DAY_MS = 86_400_000;
export const TASK_RETENTION_MS = 14 * DAY_MS;
export const NOTIFICATION_RETENTION_MS = 90 * DAY_MS;
export const QUOTA_RETENTION_MS = 90 * DAY_MS;
/** Most rows one delete statement removes. */
export const RETENTION_BATCH = 2_000;

/**
 * Test seam. Production passes none, and every table is processed. Once a scope is given it is MANDATORY: a table whose
 * ids are not listed is skipped (never processed unscoped), and an empty list throws instead of matching everything.
 * That is what lets a test run against the shared database without ever touching a row it did not create.
 */
export type RetentionScope = { taskIds?: string[]; notificationIds?: string[]; quotaUsageIds?: string[]; eventIds?: string[] };
export type RetentionOptions = { limit?: number; scope?: RetentionScope };
export type RetentionResult = { tasks: number; notifications: number; quotaUsage: number; paymentEvents: number };

function checkIds(name: string, ids: string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || id === "")) throw new Error(`retention scope "${name}" must be a non-empty list of ids`);
  return ids;
}

function checkLimit(limit: number | undefined): number {
  const n = limit ?? RETENTION_BATCH;
  if (!Number.isInteger(n) || n < 1) throw new Error("retention limit must be a positive integer");
  return n;
}

type Table = "tasks" | "notifications" | "youtube_quota_usage";

/** Delete up to `limit` rows of `table` that match `predicate` (and `ids`, when given); returns how many went. ONE statement. */
async function deleteBatch(db: DbLike, table: Table, predicate: SQL, limit: number, ids: string[] | undefined): Promise<number> {
  const t = sql.raw(table); // one of the three constants above, never user input
  const only = ids ? sql`and id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const [row] = (await db.execute(sql`
    with picked as materialized (
      select id from ${t} where ${predicate} ${only} limit ${limit} for update skip locked
    ), gone as (
      delete from ${t} x using picked where x.id = picked.id and ${predicate} returning x.id
    )
    select count(*)::int as n from gone
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

const iso = (d: Date) => d.toISOString();

/** Finished tasks (done, failed, cancelled) not touched for 14 days. Pending and running tasks are never deleted, however old. */
export async function purgeOldTasks(db: DbLike, now: Date, opts: { limit?: number; ids?: string[] } = {}): Promise<number> {
  const cutoff = iso(new Date(now.getTime() - TASK_RETENTION_MS));
  return deleteBatch(db, "tasks", sql`status in ('done', 'failed', 'cancelled') and updated_at < ${cutoff}::timestamptz`, checkLimit(opts.limit), checkIds("ids", opts.ids));
}

/** Notifications that were read and are older than 90 days. Unread ones stay until the user reads them. */
export async function purgeReadNotifications(db: DbLike, now: Date, opts: { limit?: number; ids?: string[] } = {}): Promise<number> {
  const cutoff = iso(new Date(now.getTime() - NOTIFICATION_RETENTION_MS));
  return deleteBatch(db, "notifications", sql`is_read and created_at < ${cutoff}::timestamptz`, checkLimit(opts.limit), checkIds("ids", opts.ids));
}

/** Daily YouTube quota counters for UTC days more than 90 days back. */
export async function purgeOldQuotaUsage(db: DbLike, now: Date, opts: { limit?: number; ids?: string[] } = {}): Promise<number> {
  const cutoffDay = utcDateString(new Date(now.getTime() - QUOTA_RETENTION_MS));
  return deleteBatch(db, "youtube_quota_usage", sql`date < ${cutoffDay}::date`, checkLimit(opts.limit), checkIds("ids", opts.ids));
}

/**
 * All four, one statement each. A failing table does not keep the others from running: its error is collected and
 * thrown at the end (the tick records it in job_schedules.last_error), after everything that could run did.
 */
export async function runRetention(db: DbLike, now: Date, opts: RetentionOptions = {}): Promise<RetentionResult> {
  const limit = checkLimit(opts.limit);
  const scope = opts.scope;
  const ids = scope && {
    tasks: checkIds("taskIds", scope.taskIds),
    notifications: checkIds("notificationIds", scope.notificationIds),
    quota: checkIds("quotaUsageIds", scope.quotaUsageIds),
    events: checkIds("eventIds", scope.eventIds),
  };
  const errors: string[] = [];
  const step = async (name: string, enabled: boolean, run: () => Promise<number>): Promise<number> => {
    if (!enabled) return 0;
    try {
      return await run();
    } catch (e) {
      errors.push(`${name}: ${safeErrorMessage(e)}`);
      return 0;
    }
  };

  const result: RetentionResult = {
    tasks: await step("tasks", !ids || !!ids.tasks, () => purgeOldTasks(db, now, { limit, ids: ids?.tasks })),
    notifications: await step("notifications", !ids || !!ids.notifications, () => purgeReadNotifications(db, now, { limit, ids: ids?.notifications })),
    quotaUsage: await step("youtube_quota_usage", !ids || !!ids.quota, () => purgeOldQuotaUsage(db, now, { limit, ids: ids?.quota })),
    // Catch-up: also removes the unmatched events the 5-minute purge's one-day window cannot reach.
    paymentEvents: await step("payment_events", !ids || !!ids.events, () => purgeUnmatchedEvents(db, now, { catchUp: true, limit, eventIds: ids?.events })),
  };
  console.log(`[maintenance.retention] deleted tasks=${result.tasks} notifications=${result.notifications} quota_usage=${result.quotaUsage} payment_events=${result.paymentEvents}`);
  if (errors.length > 0) throw new Error(`maintenance.retention: ${errors.join("; ")}`);
  return result;
}
