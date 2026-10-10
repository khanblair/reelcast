/**
 * Lifetime-metric snapshots (`video_analytics`): one row per (video, UTC day), upserted on
 * every fetch. The Convex version scanned for the day's row with `.filter`; here the unique
 * (video_id, day) index + ON CONFLICT makes the upsert atomic and idempotent.
 *
 * Impressions / CTR / revenue are intentionally never written (the API does not expose them
 * to this integration); those columns stay NULL and the UI hides them.
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
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

/** Rows per multi-row upsert (11 bind parameters each). */
const SNAPSHOT_CHUNK = 100;

/**
 * Upsert many snapshots (possibly for different videos) in ONE statement. Same rules as `upsertSnapshot`, row by row:
 * the row lands on (video_id, day) where day = the UTC day of that input's `fetchedAt`; on conflict `fetched_at` and
 * `youtube_video_id` are overwritten and a metric is overwritten only when the input provides it (a missing metric is a
 * NULL in `excluded`, which `coalesce` turns back into the stored value); a conflicting row owned by another user is
 * left untouched. Inputs must be for distinct (video, day) pairs (Postgres refuses to touch one row twice in a statement).
 */
async function upsertSnapshots(db: DbLike, inputs: UpsertSnapshotInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const rows = inputs.map((input) => {
    const fetchedAt = input.fetchedAt ?? new Date();
    const metrics: SnapshotMetrics = {};
    for (const k of ["views", "watchTimeMinutes", "avgViewDurationSec", "likes", "comments", "subscribersGained"] as const) {
      if (input[k] !== undefined) metrics[k] = input[k];
    }
    return { userId: input.userId, videoId: input.videoId, youtubeVideoId: input.youtubeVideoId, day: utcDay(fetchedAt), fetchedAt, ...metrics };
  });
  await db
    .insert(videoAnalytics)
    .values(rows)
    .onConflictDoUpdate({
      target: [videoAnalytics.videoId, videoAnalytics.day],
      set: {
        fetchedAt: sql`excluded.fetched_at`,
        youtubeVideoId: sql`excluded.youtube_video_id`,
        views: sql`coalesce(excluded.views, ${videoAnalytics.views})`,
        watchTimeMinutes: sql`coalesce(excluded.watch_time_minutes, ${videoAnalytics.watchTimeMinutes})`,
        avgViewDurationSec: sql`coalesce(excluded.avg_view_duration_sec, ${videoAnalytics.avgViewDurationSec})`,
        likes: sql`coalesce(excluded.likes, ${videoAnalytics.likes})`,
        comments: sql`coalesce(excluded.comments, ${videoAnalytics.comments})`,
        subscribersGained: sql`coalesce(excluded.subscribers_gained, ${videoAnalytics.subscribersGained})`,
      },
      setWhere: sql`${videoAnalytics.userId} = excluded.user_id`,
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
  /** Contract (agent C2): addYoutubeQuota(db, userId, units). Called once per run with the number of API requests made. */
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

  // ONE read gives the videos, the number of ALL matching videos and the primary channel:
  //  - `count(*) over ()` is evaluated before LIMIT, so it is the full count (and every returned row carries it);
  //  - the channel is a scalar subquery, the same on every row.
  // LIMIT 0 would hide the count, hence the floor of 1 here and the slice below.
  const primaryChannelId = sql<string | null>`(select c.id from youtube_channels c where c.user_id = ${userId} and c.is_primary = true limit 1)`;
  const pick = {
    id: videos.id,
    publishedVideoId: videos.publishedVideoId,
    publishedAt: videos.publishedAt,
    channelId: primaryChannelId,
    total: sql<number>`count(*) over ()`.mapWith(Number),
  };
  const found = opts.videoId
    ? await db
        .select(pick)
        .from(videos)
        .where(and(eq(videos.id, opts.videoId), eq(videos.userId, userId)))
        .limit(1)
    : await db
        .select(pick)
        .from(videos)
        .where(and(eq(videos.userId, userId), eq(videos.status, "published"), isNotNull(videos.publishedVideoId)))
        .orderBy(sql`${videos.publishedAt} desc nulls last`, desc(videos.createdAt))
        .limit(Math.max(1, maxVideos));

  // No video rows means the channel did not ride along: look it up on its own (the rare, empty case).
  const channelId =
    found.length > 0
      ? found[0].channelId
      : ((
          await db
            .select({ id: youtubeChannels.id })
            .from(youtubeChannels)
            .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.isPrimary, true)))
            .limit(1)
        )[0]?.id ?? null);
  if (!channelId) throw badRequest("YouTube account is not connected");

  let rows: { id: string; publishedVideoId: string | null; publishedAt: Date | null }[];
  let total: number;
  if (opts.videoId) {
    if (!found[0]) throw notFound("Video not found");
    if (!found[0].publishedVideoId) throw badRequest("Video has not been published to YouTube yet");
    rows = found;
    total = 1;
  } else {
    rows = found.slice(0, maxVideos);
    total = found[0]?.total ?? 0;
  }

  let token: { accessToken: string; channelId: string };
  try {
    token = await deps.getToken(channelId);
  } catch {
    throw badRequest(AUTH_MESSAGE);
  }

  const endDate = utcDay(now());
  const results: SnapshotResult[] = [];
  let authFailed = false;
  // Snapshots are collected here and written together (see flushSnapshots); `requests` is the number of YouTube
  // reports requested, which is exactly the quota units used.
  const pending: { result: SnapshotResult; input: UpsertSnapshotInput }[] = [];
  let requests = 0;

  const one = async (v: (typeof rows)[number]): Promise<SnapshotResult> => {
    const youtubeVideoId = v.publishedVideoId!;
    // Lifetime window: from the publish day (30 days back when unknown, as before).
    const start = v.publishedAt ?? addDays(now(), -30);
    const startDate = utcDay(start) > endDate ? endDate : utcDay(start);
    try {
      requests++;
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
      const result: SnapshotResult = { videoId: v.id, ok: true, data: { userId, videoId: v.id, youtubeVideoId, fetchedAt, ...metrics } };
      pending.push({ result, input: { userId, videoId: v.id, youtubeVideoId, fetchedAt, ...metrics } });
      return result;
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

  try {
    for (let i = 0; i < rows.length && !authFailed; i += CONCURRENCY) {
      if (i > 0 && Date.now() > deadline) break;
      results.push(...(await Promise.all(rows.slice(i, i + CONCURRENCY).map(one))));
    }
  } finally {
    // Whatever happened above (a rejected token included), what was fetched is stored and what was requested is metered.
    await flushSnapshots(db, pending);
    if (requests > 0) {
      try {
        await deps.addQuota(userId, requests);
      } catch (e) {
        console.error("[analytics] failed to record YouTube quota use", { units: requests, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (authFailed) {
    await markChannelOAuthStatus(db, channelId, "token_expired");
    throw badRequest(AUTH_MESSAGE);
  }

  return { results, total, processed: results.length, truncated: results.length < total };
}

/**
 * Store the collected snapshots, one multi-row statement per chunk. If a chunk is rejected (say, a video was deleted
 * while its report was in flight), its videos are retried one by one so that only the failing one is lost, and it is
 * reported exactly as a failed single write always was: `ok: false, "Failed to fetch analytics"`. Never throws.
 */
async function flushSnapshots(db: DbLike, pending: { result: SnapshotResult; input: UpsertSnapshotInput }[]): Promise<void> {
  const fail = (p: (typeof pending)[number], e: unknown) => {
    console.error("[analytics] snapshot failed", { videoId: p.input.videoId, error: e instanceof Error ? e.message : String(e) });
    p.result.ok = false;
    p.result.error = "Failed to fetch analytics";
    delete p.result.data;
  };
  for (let i = 0; i < pending.length; i += SNAPSHOT_CHUNK) {
    const chunk = pending.slice(i, i + SNAPSHOT_CHUNK);
    try {
      await upsertSnapshots(db, chunk.map((p) => p.input));
    } catch (e) {
      if (chunk.length === 1) {
        fail(chunk[0], e);
        continue;
      }
      for (const p of chunk) {
        try {
          await upsertSnapshot(db, p.input);
        } catch (err) {
          fail(p, err);
        }
      }
    }
  }
}
