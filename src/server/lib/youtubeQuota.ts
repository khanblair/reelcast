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
