/**
 * Daily per-video stats ingest (`video_daily_stats`).
 *
 * The YouTube Analytics API lags 48-72h and revises recent days, so every run re-pulls a rolling
 * window (last 7 UTC days) and overwrites it with an upsert; running a user twice is harmless.
 *
 * One request covers up to 25 videos via `dimensions=video,day` + `filters=video==ID1,ID2,..`
 * (the docs allow adding the `video` filter to `dimensions` when several ids are given). If the
 * API rejects that shape we fall back to the documented single-video `dimensions=day` report.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videoDailyStats, videos } from "@/db/schema";
import {
  DAILY_METRICS,
  YtAnalyticsError,
  addDays,
  rowToRecord,
  runReport,
  utcDay,
  type ReportTable,
} from "./ytReports";
import { markChannelOAuthStatus } from "./snapshots";

export const INGEST_WINDOW_DAYS = 7;
export const VIDEOS_PER_REQUEST = 25;
export const MAX_VIDEOS_PER_USER = 200;
/** Leave headroom of the shared 10k/day YouTube quota for uploads (1600 units each). */
export const INGEST_QUOTA_CEILING = 8_000;

export type IngestDeps = {
  db: DbLike;
  getToken: (channelRowId: string) => Promise<{ accessToken: string; channelId: string }>;
  addQuota: (userId: string, units: number) => Promise<unknown>;
  getQuotaUsed: (userId: string) => Promise<number>;
  now?: () => Date;
};

export type DailyRow = typeof videoDailyStats.$inferInsert;

export type UserIngestResult = {
  userId: string;
  status: "ok" | "no_videos" | "skipped_quota" | "auth_failed" | "forbidden" | "error";
  rows: number;
  requests: number;
};

const INT4_MAX = 2_147_483_647;
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), INT4_MAX) : 0);
const float = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(v, 0) : 0);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Turn one report table into daily rows. `video` column (when present) maps YouTube id -> our id. */
export function dailyRowsFromTable(
  table: ReportTable,
  userId: string,
  idByYoutubeId: Map<string, string>,
  singleVideoId?: string,
): DailyRow[] {
  const out = new Map<string, DailyRow>();
  for (const raw of table.rows) {
    const rec = rowToRecord(table.headers, raw);
    const day = String(rec.day ?? "");
    if (!DAY_RE.test(day)) continue;
    const videoId = singleVideoId ?? idByYoutubeId.get(String(rec.video ?? ""));
    if (!videoId) continue;
    out.set(`${videoId}|${day}`, {
      videoId,
      userId,
      day,
      views: int(rec.views),
      watchTimeMinutes: float(rec.estimatedMinutesWatched),
      avgViewDurationSec: typeof rec.averageViewDuration === "number" ? float(rec.averageViewDuration) : null,
      likes: int(rec.likes),
      comments: int(rec.comments),
      subscribersGained: int(rec.subscribersGained),
      subscribersLost: int(rec.subscribersLost),
    });
  }
  return [...out.values()];
}

/** Idempotent upsert keyed by (video_id, day); later fetches overwrite earlier (revised) numbers. */
export async function upsertDailyRows(db: DbLike, rows: DailyRow[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db
      .insert(videoDailyStats)
      .values(chunk)
      .onConflictDoUpdate({
        target: [videoDailyStats.videoId, videoDailyStats.day],
        set: {
          views: sql`excluded.views`,
          watchTimeMinutes: sql`excluded.watch_time_minutes`,
          avgViewDurationSec: sql`excluded.avg_view_duration_sec`,
          likes: sql`excluded.likes`,
          comments: sql`excluded.comments`,
          subscribersGained: sql`excluded.subscribers_gained`,
          subscribersLost: sql`excluded.subscribers_lost`,
          updatedAt: sql`now()`,
        },
        // Never let a conflicting row owned by someone else be touched.
        setWhere: sql`${videoDailyStats.userId} = excluded.user_id`,
      });
    n += chunk.length;
  }
  return n;
}

/** Ingest the rolling window for one user's published videos. Never throws on API/auth problems. */
export async function ingestUserDailyStats(
  deps: IngestDeps,
  user: { userId: string; channelRowId: string },
): Promise<UserIngestResult> {
  const { db } = deps;
  const { userId } = user;
  const now = deps.now ?? (() => new Date());
  const result: UserIngestResult = { userId, status: "ok", rows: 0, requests: 0 };

  if ((await deps.getQuotaUsed(userId)) >= INGEST_QUOTA_CEILING) return { ...result, status: "skipped_quota" };

  const vids = await db
    .select({ id: videos.id, youtubeId: videos.publishedVideoId })
    .from(videos)
    .where(and(eq(videos.userId, userId), eq(videos.status, "published"), sql`${videos.publishedVideoId} is not null`))
    .orderBy(sql`${videos.publishedAt} desc nulls last`, asc(videos.id))
    .limit(MAX_VIDEOS_PER_USER);
  if (vids.length === 0) return { ...result, status: "no_videos" };

  let token: { accessToken: string; channelId: string };
  try {
    token = await deps.getToken(user.channelRowId);
  } catch {
    return { ...result, status: "auth_failed" };
  }

  const endDate = utcDay(now());
  const startDate = utcDay(addDays(now(), -(INGEST_WINDOW_DAYS - 1)));
  const base = { channelId: token.channelId, startDate, endDate, metrics: DAILY_METRICS } as const;

  for (let i = 0; i < vids.length; i += VIDEOS_PER_REQUEST) {
    const batch = vids.slice(i, i + VIDEOS_PER_REQUEST);
    const idByYoutubeId = new Map(batch.map((v) => [v.youtubeId!, v.id]));
    let rows: DailyRow[] = [];
    try {
      await deps.addQuota(userId, 1);
      result.requests++;
      try {
        const table = await runReport(token.accessToken, { ...base, dimensions: ["video", "day"], videoIds: batch.map((v) => v.youtubeId!) });
        rows = dailyRowsFromTable(table, userId, idByYoutubeId);
      } catch (e) {
        if (!(e instanceof YtAnalyticsError) || e.kind !== "bad_request") throw e;
        // Shape rejected: documented single-video report instead.
        for (const v of batch) {
          await deps.addQuota(userId, 1);
          result.requests++;
          try {
            const table = await runReport(token.accessToken, { ...base, dimensions: ["day"], videoIds: [v.youtubeId!], sort: "day" });
            rows.push(...dailyRowsFromTable(table, userId, idByYoutubeId, v.id));
          } catch (inner) {
            if (inner instanceof YtAnalyticsError && inner.kind === "bad_request") continue; // e.g. video not reportable; skip it
            throw inner;
          }
        }
      }
    } catch (e) {
      if (e instanceof YtAnalyticsError) {
        if (e.kind === "auth") {
          await markChannelOAuthStatus(db, user.channelRowId, "token_expired");
          return { ...result, status: "auth_failed" };
        }
        if (e.kind === "forbidden") return { ...result, status: "forbidden" };
        if (e.kind === "rate_limited") throw e; // let the task back off and retry
        console.error("[analytics.dailyIngest] API error", { userId, status: e.status });
        return { ...result, status: "error" };
      }
      throw e;
    }
    result.rows += await upsertDailyRows(db, rows);
  }
  return result;
}

/** Next connected users after `afterUserId` (keyset pagination by user id) that have published videos. */
export async function selectIngestUsers(
  db: DbLike,
  afterUserId: string | null,
  limit: number,
): Promise<{ userId: string; channelRowId: string }[]> {
  const rows = (await db.execute(sql`
    select yc.user_id as "userId", yc.id as "channelRowId"
    from youtube_channels yc
    where yc.is_primary
      and yc.oauth_status = 'connected'
      and (${afterUserId}::uuid is null or yc.user_id > ${afterUserId}::uuid)
      and exists (
        select 1 from videos v
        where v.user_id = yc.user_id and v.status = 'published' and v.published_video_id is not null
      )
    order by yc.user_id
    limit ${limit}
  `)) as unknown as { userId: string; channelRowId: string }[];
  return rows.map((r) => ({ userId: r.userId, channelRowId: r.channelRowId }));
}
