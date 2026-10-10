/**
 * Per-user daily YouTube Data API quota counter (units, UTC day).
 *
 * Replaces convex/admin/quota.ts addQuotaUsage. The increment is ONE atomic
 * `INSERT .. ON CONFLICT DO UPDATE` so concurrent callers (poller, publish, content
 * intelligence) never lose an update under READ COMMITTED.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { youtubeQuotaUsage } from "@/db/schema";
import { RpcError } from "@/server/rpc/errors";

/** "YYYY-MM-DD" in UTC (YouTube resets quota at midnight Pacific; the app has always keyed by UTC day). */
export function utcDateString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Units used by `userId` on `date` (default: today, UTC). 0 when nothing was recorded. */
export async function getYoutubeQuotaUsed(db: DbLike, userId: string, date: string = utcDateString()): Promise<number> {
  const [row] = await db
    .select({ unitsUsed: youtubeQuotaUsage.unitsUsed })
    .from(youtubeQuotaUsage)
    .where(and(eq(youtubeQuotaUsage.userId, userId), eq(youtubeQuotaUsage.date, date)))
    .limit(1);
  return row?.unitsUsed ?? 0;
}

/**
 * Add `units` to today's usage and return the new total. Non-positive / non-finite
 * `units` are a no-op that just returns the current total.
 */
export async function addYoutubeQuota(db: DbLike, userId: string, units: number): Promise<number> {
  const n = Number.isFinite(units) ? Math.trunc(units) : 0;
  const today = utcDateString();
  if (n <= 0) return getYoutubeQuotaUsed(db, userId, today);
  const rows = (await db.execute(sql`
    insert into youtube_quota_usage (user_id, date, units_used)
    values (${userId}, ${today}::date, ${n})
    on conflict (user_id, date) do update
      set units_used = youtube_quota_usage.units_used + ${n}
    returning units_used
  `)) as unknown as { units_used: number }[];
  return Number(rows[0]?.units_used ?? n);
}

/**
 * Most units a user may have recorded for today before their own (user-triggered) YouTube calls are refused. The same
 * 8,000 as INGEST_QUOTA_CEILING in analytics/dailyIngest.ts and for the same reason: the Data API gives 10,000 units a
 * day and an upload alone costs 1,600, so the last 2,000 stay reserved for publishing.
 */
export const INTERACTIVE_QUOTA_CEILING = 8_000;

/**
 * Refuse a call that would cost `cost` units when fewer than that remain under `ceiling` for today.
 *
 * Call it BEFORE the YouTube request (the cost is recorded afterwards by addYoutubeQuota). One statement. It is a plain
 * read, not a reservation: callers racing each other can overshoot the ceiling by the cost of the calls in flight,
 * which the 2,000-unit reserve absorbs, exactly like the ingest's own check.
 */
export async function assertYoutubeQuotaAvailable(
  db: DbLike,
  userId: string,
  cost: number,
  ceiling: number = INTERACTIVE_QUOTA_CEILING,
): Promise<void> {
  const used = await getYoutubeQuotaUsed(db, userId);
  if (used + cost > ceiling) {
    throw new RpcError(
      "RATE_LIMITED",
      `Not enough YouTube API quota left today for this request (it needs ${cost} units, ${Math.max(ceiling - used, 0)} are left). It resets at 00:00 UTC.`,
    );
  }
}
