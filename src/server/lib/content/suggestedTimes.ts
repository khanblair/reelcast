/**
 * Best publish hours from the user's own history (port of convex/scheduling.getSuggestedTimes).
 * Aggregation happens in SQL; only one row per publish hour (<= 24) reaches the server.
 *
 * NOTE: `video_analytics.ctr` is not populated by any current fetcher, so the CTR half of the score
 * is 0 for everyone and ranking is effectively by average views. The scoring below already
 * treats "no CTR data" (maxCtr = 0) as zero weight; it does not re-weight views.
 */
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";

export const MIN_DATA_POINTS = 5;

export type HourBucket = { hourUtc: number; count: number; totalViews: number; totalCtr: number };

const NOT_ENOUGH = { suggestedTimes: null, reason: "not_enough_data" as const, videosNeeded: MIN_DATA_POINTS };

export async function countPublished(db: DbLike, userId: string): Promise<number> {
  const [row] = (await db.execute(sql`
    select count(*)::int as published from videos where user_id = ${userId} and status = 'published'
  `)) as unknown as { published: number }[];
  return Number(row?.published ?? 0);
}

/** Latest analytics snapshot per published video, bucketed by UTC publish hour. */
export async function loadHourBuckets(db: DbLike, userId: string): Promise<HourBucket[]> {
  const rows = (await db.execute(sql`
    select extract(hour from v.published_at at time zone 'utc')::int as hour_utc,
           count(*)::int as n,
           coalesce(sum(a.views), 0)::float8 as total_views,
           coalesce(sum(a.ctr), 0)::float8 as total_ctr
    from videos v
    join lateral (
      select views, ctr from video_analytics
      where video_id = v.id
      order by fetched_at desc
      limit 1
    ) a on true
    where v.user_id = ${userId} and v.status = 'published' and v.published_at is not null
    group by 1
  `)) as unknown as { hour_utc: number; n: number; total_views: number; total_ctr: number }[];
  return rows.map((r) => ({ hourUtc: Number(r.hour_utc), count: Number(r.n), totalViews: Number(r.total_views), totalCtr: Number(r.total_ctr) }));
}

/** Normalised CTR (60%) + normalised views (40%) per hour; the three best hours. */
export function scoreHourBuckets(buckets: HourBucket[]) {
  const analysed = buckets.reduce((s, b) => s + b.count, 0);
  if (analysed < MIN_DATA_POINTS) return NOT_ENOUGH;

  const avg = buckets.map((b) => ({ hour: b.hourUtc, count: b.count, avgViews: b.totalViews / b.count, avgCtr: b.totalCtr / b.count }));
  const maxCtr = Math.max(...avg.map((b) => b.avgCtr));
  const maxViews = Math.max(...avg.map((b) => b.avgViews));

  const scored = avg
    .map((b) => {
      const score = (maxCtr > 0 ? (b.avgCtr / maxCtr) * 0.6 : 0) + (maxViews > 0 ? (b.avgViews / maxViews) * 0.4 : 0);
      return {
        hourUtc: b.hour,
        hourEat: (b.hour + 3) % 24, // EAT = UTC+3
        avgCtr: Math.round(b.avgCtr * 1000) / 1000,
        avgViews: Math.round(b.avgViews),
        sampleSize: b.count,
        confidence: b.count >= 3 ? ("high" as const) : ("low" as const),
        score: Math.round(score * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return { suggestedTimes: scored, reason: "analytics" as const, totalVideosAnalysed: analysed };
}

export async function computeSuggestedTimes(db: DbLike, userId: string) {
  if ((await countPublished(db, userId)) < MIN_DATA_POINTS) return NOT_ENOUGH;
  return scoreHourBuckets(await loadHourBuckets(db, userId));
}
