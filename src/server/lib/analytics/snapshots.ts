/**
 * Lifetime-metric snapshots (`video_analytics`): one row per (video, UTC day), upserted on
 * every fetch. The Convex version scanned for the day's row with `.filter`; here the unique
 * (video_id, day) index + ON CONFLICT makes the upsert atomic and idempotent.
 *
 * Impressions / CTR / revenue are intentionally never written (the API does not expose them
 * to this integration); those columns stay NULL and the UI hides them.
 */
import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videoAnalytics, videos, youtubeChannels } from "@/db/schema";
import { badRequest, notFound } from "@/server/rpc/errors";
import { SNAPSHOT_METRICS, YtAnalyticsError, addDays, rowToRecord, runReport, utcDay } from "./ytReports";

export type SnapshotMetrics = {
  views?: number;
  watchTimeMinutes?: number;
  avgViewDurationSec?: number;
  likes?: number;
  comments?: number;
  subscribersGained?: number;
};

const INT4_MAX = 2_147_483_647;
const toInt = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), INT4_MAX) : undefined;
const toFloat = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? n : undefined);

/** Map a report row (keyed by API metric name) to our snapshot columns. */
export function metricsFromRecord(rec: Record<string, unknown>): SnapshotMetrics {
  const out: SnapshotMetrics = {
    views: toInt(rec.views),
    watchTimeMinutes: toFloat(rec.estimatedMinutesWatched),
    avgViewDurationSec: toFloat(rec.averageViewDuration),
    likes: toInt(rec.likes),
    comments: toInt(rec.comments),
    subscribersGained: toInt(rec.subscribersGained),
  };
  for (const k of Object.keys(out) as (keyof SnapshotMetrics)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export type UpsertSnapshotInput = SnapshotMetrics & {
  userId: string;
  videoId: string;
  youtubeVideoId: string;
  fetchedAt?: Date;
};

/** Insert today's (UTC) snapshot for a video, or refresh it. Only provided metrics are overwritten. */
export async function upsertSnapshot(db: DbLike, input: UpsertSnapshotInput): Promise<void> {
  const fetchedAt = input.fetchedAt ?? new Date();
  const day = utcDay(fetchedAt);
  const metrics: SnapshotMetrics = {};
  for (const k of ["views", "watchTimeMinutes", "avgViewDurationSec", "likes", "comments", "subscribersGained"] as const) {
    if (input[k] !== undefined) metrics[k] = input[k];
  }
  await db
    .insert(videoAnalytics)
    .values({ userId: input.userId, videoId: input.videoId, youtubeVideoId: input.youtubeVideoId, day, fetchedAt, ...metrics })
    .onConflictDoUpdate({
      target: [videoAnalytics.videoId, videoAnalytics.day],
      set: { fetchedAt, youtubeVideoId: input.youtubeVideoId, ...metrics },
      setWhere: eq(videoAnalytics.userId, input.userId),
    });
}

/** Record that a token is no longer usable (replaces Convex internalSetYoutubeOAuthStatus). */
export async function markChannelOAuthStatus(
  db: DbLike,
  channelRowId: string,
  status: "connected" | "token_expired" | "revoked" | "unknown",
): Promise<void> {
  await db.update(youtubeChannels).set({ oauthStatus: status, updatedAt: new Date() }).where(eq(youtubeChannels.id, channelRowId));
}

export type SnapshotDeps = {
  db: DbLike;
  /** Contract (agent B): getValidAccessToken(db, youtubeChannelRowId). */
  getToken: (channelRowId: string) => Promise<{ accessToken: string; channelId: string }>;
  /** Contract (agent C2): addYoutubeQuota(db, userId, units). Called once per API request. */
  addQuota: (userId: string, units: number) => Promise<unknown>;
  now?: () => Date;
};

export type SnapshotResult = { videoId: string; ok: boolean; data?: Record<string, unknown> | null; error?: string };
export type SnapshotRun = { results: SnapshotResult[]; total: number; processed: number; truncated: boolean };

const CONCURRENCY = 5;
export const MAX_VIDEOS_PER_FETCH = 50;
const DEFAULT_BUDGET_MS = 40_000;
const AUTH_MESSAGE = "YouTube authorization expired. Reconnect your YouTube account.";

/**
 * Fetch lifetime metrics for the user's published videos (or one video) and store snapshots.
 * Owner-scoped: only the caller's rows are read or written. Bounded: at most `maxVideos` videos
 * (most recently published first), 5 requests in flight, stops starting new batches after
 * `budgetMs`. `truncated` says some published videos were not refreshed this time.
 */
export async function fetchSnapshotsForUser(
  deps: SnapshotDeps,
  userId: string,
  opts: { videoId?: string; maxVideos?: number; budgetMs?: number } = {},
): Promise<SnapshotRun> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const maxVideos = opts.maxVideos ?? MAX_VIDEOS_PER_FETCH;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);

  const [channel] = await db
    .select({ id: youtubeChannels.id })
    .from(youtubeChannels)
    .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.isPrimary, true)))
    .limit(1);
  if (!channel) throw badRequest("YouTube account is not connected");

  let rows: { id: string; publishedVideoId: string | null; publishedAt: Date | null }[];
  let total: number;
  if (opts.videoId) {
    rows = await db
      .select({ id: videos.id, publishedVideoId: videos.publishedVideoId, publishedAt: videos.publishedAt })
      .from(videos)
      .where(and(eq(videos.id, opts.videoId), eq(videos.userId, userId)))
      .limit(1);
    if (!rows[0]) throw notFound("Video not found");
    if (!rows[0].publishedVideoId) throw badRequest("Video has not been published to YouTube yet");
    total = 1;
  } else {
    const where = and(eq(videos.userId, userId), eq(videos.status, "published"), isNotNull(videos.publishedVideoId));
    rows = await db
      .select({ id: videos.id, publishedVideoId: videos.publishedVideoId, publishedAt: videos.publishedAt })
      .from(videos)
      .where(where)
      .orderBy(sql`${videos.publishedAt} desc nulls last`, desc(videos.createdAt))
      .limit(maxVideos);
    const [{ n }] = await db.select({ n: count() }).from(videos).where(where);
    total = Number(n);
  }

  let token: { accessToken: string; channelId: string };
  try {
    token = await deps.getToken(channel.id);
  } catch {
    throw badRequest(AUTH_MESSAGE);
  }

  const endDate = utcDay(now());
  const results: SnapshotResult[] = [];
  let authFailed = false;

  const one = async (v: (typeof rows)[number]): Promise<SnapshotResult> => {
    const youtubeVideoId = v.publishedVideoId!;
    // Lifetime window: from the publish day (30 days back when unknown, as before).
    const start = v.publishedAt ?? addDays(now(), -30);
    const startDate = utcDay(start) > endDate ? endDate : utcDay(start);
    try {
      await deps.addQuota(userId, 1);
      const table = await runReport(token.accessToken, {
        channelId: token.channelId,
        startDate,
        endDate,
        metrics: SNAPSHOT_METRICS,
        videoIds: [youtubeVideoId],
      });
      if (table.rows.length === 0) return { videoId: v.id, ok: true, data: null };
      const metrics = metricsFromRecord(rowToRecord(table.headers, table.rows[0]));
      const fetchedAt = now();
      await upsertSnapshot(db, { userId, videoId: v.id, youtubeVideoId, fetchedAt, ...metrics });
      return { videoId: v.id, ok: true, data: { userId, videoId: v.id, youtubeVideoId, fetchedAt, ...metrics } };
    } catch (e) {
      if (e instanceof YtAnalyticsError) {
        if (e.kind === "auth") {
          authFailed = true;
          return { videoId: v.id, ok: false, error: AUTH_MESSAGE };
        }
        if (e.kind === "forbidden") {
          return { videoId: v.id, ok: false, error: "YouTube Analytics access is not granted for this channel (reconnect YouTube and allow analytics access)." };
        }
        return { videoId: v.id, ok: false, error: e.message };
      }
      console.error("[analytics] snapshot failed", { videoId: v.id, error: e instanceof Error ? e.message : String(e) });
      return { videoId: v.id, ok: false, error: "Failed to fetch analytics" };
    }
  };

  for (let i = 0; i < rows.length && !authFailed; i += CONCURRENCY) {
    if (i > 0 && Date.now() > deadline) break;
    results.push(...(await Promise.all(rows.slice(i, i + CONCURRENCY).map(one))));
  }

  if (authFailed) {
    await markChannelOAuthStatus(db, channel.id, "token_expired");
    throw badRequest(AUTH_MESSAGE);
  }

  return { results, total, processed: results.length, truncated: results.length < total };
}
