/**
 * Read side of analytics. All aggregation happens in SQL (latest snapshot per video via
 * DISTINCT ON, sums/averages/group-by), always scoped by user id.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videoAnalytics, videoDailyStats } from "@/db/schema";
import { addDays, utcDay } from "./ytReports";

/** Latest snapshot row per video for a user (a subquery usable as a table). */
function latestPerVideo(db: DbLike, userId: string) {
  return db
    .selectDistinctOn([videoAnalytics.videoId])
    .from(videoAnalytics)
    .where(eq(videoAnalytics.userId, userId))
    .orderBy(videoAnalytics.videoId, desc(videoAnalytics.day), desc(videoAnalytics.fetchedAt))
    .as("latest");
}

/** Most recent snapshot of one video, owner-scoped (null when none / not the caller's). */
export async function getLatestForVideo(db: DbLike, userId: string, videoId: string) {
  const [row] = await db
    .select()
    .from(videoAnalytics)
    .where(and(eq(videoAnalytics.userId, userId), eq(videoAnalytics.videoId, videoId)))
    .orderBy(desc(videoAnalytics.day), desc(videoAnalytics.fetchedAt))
    .limit(1);
  return row ?? null;
}

/** Latest snapshot per video, most recently fetched first, at most `limit` videos. */
export async function listLatestForUser(db: DbLike, userId: string, limit: number) {
  const latest = latestPerVideo(db, userId);
  return db.select().from(latest).orderBy(desc(latest.fetchedAt)).limit(limit);
}

/**
 * Channel totals over the latest snapshot of each video + the top 5 videos by views, in ONE statement: the totals are
 * window aggregates over the whole `latest` set, computed before the LIMIT trims it to the top 5 (so every returned
 * row carries the same totals). No rows at all means no videos: the same zeros / null the plain aggregate gave.
 */
export async function getChannelTotals(db: DbLike, userId: string) {
  const latest = latestPerVideo(db, userId);
  const rows = await db
    .select({
      videoId: latest.videoId,
      youtubeVideoId: latest.youtubeVideoId,
      views: latest.views,
      watchTimeMinutes: latest.watchTimeMinutes,
      ctr: latest.ctr,
      totalViews: sql<number>`coalesce(sum(${latest.views}) over (), 0)`.mapWith(Number),
      totalWatchTimeMinutes: sql<number>`coalesce(sum(${latest.watchTimeMinutes}) over (), 0)`.mapWith(Number),
      totalImpressions: sql<number>`coalesce(sum(${latest.impressions}) over (), 0)`.mapWith(Number),
      // avg() ignores NULLs, so this is null (not 0) when no video has CTR data.
      avgCtr: sql<number | null>`avg(${latest.ctr}) over ()`.mapWith((v) => (v === null || v === undefined ? null : Number(v))),
    })
    .from(latest)
    .orderBy(sql`${latest.views} desc nulls last`)
    .limit(5);

  const first = rows[0];
  return {
    totalViews: first?.totalViews ?? 0,
    totalWatchTimeMinutes: first?.totalWatchTimeMinutes ?? 0,
    totalImpressions: first?.totalImpressions ?? 0,
    avgCtr: first?.avgCtr ?? null,
    topVideos: rows.map((r) => ({ videoId: r.videoId, youtubeVideoId: r.youtubeVideoId, views: r.views, watchTimeMinutes: r.watchTimeMinutes, ctr: r.ctr })),
  };
}

export type SeriesPoint = {
  day: string;
  views: number;
  watchTimeMinutes: number;
  likes: number;
  comments: number;
  subscribersGained: number;
};
export type TimeSeries = { source: "daily" | "snapshots" | "none"; days: number; points: SeriesPoint[] };

function emptyPoint(day: string): SeriesPoint {
  return { day, views: 0, watchTimeMinutes: 0, likes: 0, comments: 0, subscribersGained: 0 };
}

/** Every UTC day in [today-(days-1), today]. */
export function dayRange(days: number, today = new Date()): string[] {
  return Array.from({ length: days }, (_, i) => utcDay(addDays(today, i - (days - 1))));
}

/**
 * Time series for the analytics page. Prefers real per-day deltas (`video_daily_stats`);
 * when the user has none in the window, falls back to the lifetime snapshots, carried forward
 * per video so each point is the user's cumulative total as of that day (never mixes days).
 */
export async function getTimeSeries(db: DbLike, userId: string, days: number, today = new Date()): Promise<TimeSeries> {
  const range = dayRange(days, today);
  const start = range[0];

  const daily = await db
    .select({
      day: videoDailyStats.day,
      views: sql<number>`coalesce(sum(${videoDailyStats.views}), 0)`.mapWith(Number),
      watchTimeMinutes: sql<number>`coalesce(sum(${videoDailyStats.watchTimeMinutes}), 0)`.mapWith(Number),
      likes: sql<number>`coalesce(sum(${videoDailyStats.likes}), 0)`.mapWith(Number),
      comments: sql<number>`coalesce(sum(${videoDailyStats.comments}), 0)`.mapWith(Number),
      subscribersGained: sql<number>`coalesce(sum(${videoDailyStats.subscribersGained}), 0)`.mapWith(Number),
    })
    .from(videoDailyStats)
    .where(and(eq(videoDailyStats.userId, userId), gte(videoDailyStats.day, start)))
    .groupBy(videoDailyStats.day)
    .orderBy(videoDailyStats.day);

  if (daily.length > 0) {
    const byDay = new Map(daily.map((r) => [r.day, r]));
    return { source: "daily", days, points: range.map((d) => byDay.get(d) ?? emptyPoint(d)) };
  }

  const rows = (await db.execute(sql`
    select to_char(g.day, 'YYYY-MM-DD') as day,
           coalesce(sum(s.views), 0)::float8 as views,
           coalesce(sum(s.watch_time_minutes), 0)::float8 as watch_time_minutes,
           coalesce(sum(s.likes), 0)::float8 as likes,
           coalesce(sum(s.comments), 0)::float8 as comments,
           coalesce(sum(s.subscribers_gained), 0)::float8 as subscribers_gained
    from (select (${start}::date + i) as day from generate_series(0, ${days - 1}::int) as i) g
    left join lateral (
      select distinct on (video_id) video_id, views, watch_time_minutes, likes, comments, subscribers_gained
      from video_analytics
      where user_id = ${userId} and day <= g.day
      order by video_id, day desc
    ) s on true
    where g.day >= (select min(day) from video_analytics where user_id = ${userId})
    group by g.day
    order by g.day
  `)) as unknown as {
    day: string;
    views: number;
    watch_time_minutes: number;
    likes: number;
    comments: number;
    subscribers_gained: number;
  }[];

  if (rows.length === 0) return { source: "none", days, points: [] };
  return {
    source: "snapshots",
    days,
    points: rows.map((r) => ({
      day: r.day,
      views: Number(r.views),
      watchTimeMinutes: Number(r.watch_time_minutes),
      likes: Number(r.likes),
      comments: Number(r.comments),
      subscribersGained: Number(r.subscribers_gained),
    })),
  };
}
