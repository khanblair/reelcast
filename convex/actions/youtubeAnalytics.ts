"use node";

import { v } from "convex/values";
import { action, ActionCtx } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { refreshYouTubeToken } from "../lib/youtube";

// ── Helpers ───────────────────────────────────────────────────────────────────

function toYYYYMMDD(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Returns a valid access token, refreshing it first if it's close to expiry.
 * Stores the new token in the database on refresh.
 *
 * On any refresh failure (expired or revoked refresh token), throws with
 * `.code = 401` so callers can record `youtubeOAuthStatus` before re-throwing.
 */
async function ensureValidToken(
  ctx: ActionCtx,
  user: { _id: Id<"users">; youtubeAccessToken?: string; youtubeRefreshToken?: string; youtubeTokenExpiry?: number },
): Promise<string> {
  const bufferMs = 60_000; // refresh 1 min before actual expiry
  if (
    user.youtubeAccessToken &&
    user.youtubeTokenExpiry &&
    user.youtubeTokenExpiry - bufferMs > Date.now()
  ) {
    return user.youtubeAccessToken;
  }
  if (!user.youtubeRefreshToken) {
    const err = new Error("No YouTube refresh token available — reconnect your YouTube account");
    (err as any).code = 401;
    throw err;
  }
  try {
    const { accessToken, expiresIn } = await refreshYouTubeToken(user.youtubeRefreshToken);
    await ctx.runMutation(internal.users.internalUpdateYoutubeTokens, {
      userId: user._id,
      accessToken,
      expiresIn,
    });
    return accessToken;
  } catch (refreshErr: any) {
    // refreshYouTubeToken throws a plain Error on any HTTP failure (revoked or
    // expired refresh token). Wrap it with code 401 so callers can record the
    // OAuth status before propagating the error.
    const wrapped = new Error(`YouTube token refresh failed: ${refreshErr.message}`);
    (wrapped as any).code = 401;
    throw wrapped;
  }
}

/**
 * Calls the YouTube Analytics API for a single video and returns a map of
 * metric-name → value.  Returns null when the API reports no data for the
 * requested period, or on a 403 quota / permission error (logged, not thrown).
 *
 * Throws with { code: 401 } on an expired / revoked token so callers can
 * record the status before re-throwing.
 */
async function callAnalyticsAPI(
  accessToken: string,
  youtubeVideoId: string,
  startDate: string,
  endDate: string,
  metrics: string,
): Promise<Record<string, number> | null> {
  const params = new URLSearchParams({
    ids: "channel==MINE",
    filters: `video==${youtubeVideoId}`,
    metrics,
    startDate,
    endDate,
  });

  const res = await fetch(
    `https://youtubeanalytics.googleapis.com/v2/reports?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (res.status === 401) {
    const err = new Error("YouTube Analytics token expired or revoked (401)");
    (err as any).code = 401;
    throw err;
  }

  if (res.status === 403) {
    console.error(
      `YouTube Analytics 403 for video ${youtubeVideoId} — quota exhausted or scope missing`,
    );
    return null;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube Analytics API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    columnHeaders?: { name: string }[];
    rows?: number[][];
  };

  if (!data.rows || data.rows.length === 0) return null;

  const headers = (data.columnHeaders ?? []).map((h) => h.name);
  const row = data.rows[0];
  return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
}

/**
 * Core per-video fetch logic, shared by fetchForVideo and fetchForUser.
 *
 * NOTE — metrics included: views, estimatedMinutesWatched, averageViewDuration,
 * likes, comments, subscribersGained.
 *
 * Metrics intentionally excluded and why:
 *   • impressions / impressionClickThroughRate — Studio-only metrics; not
 *     available on the public YouTube Analytics API v2 channel reports endpoint.
 *   • estimatedRevenue / rpm / cpm — require the yt-analytics-monetary.readonly
 *     OAuth scope, which is not in the current connect flow.
 *   • trafficSource* — require dimensions=insightTrafficSourceType and a
 *     separate request; out of scope for the initial integration.
 *
 * OAuth scope note: the current connect flow must include
 *   https://www.googleapis.com/auth/yt-analytics.readonly
 * to reach this endpoint. If it isn't already present, add it to the
 * GOOGLE_OAUTH_SCOPES list in the YouTube connect route.
 */
async function doFetchForVideo(
  ctx: ActionCtx,
  videoId: Id<"videos">,
): Promise<Record<string, unknown> | null> {
  // 1. Verify the caller owns this video and it is published on YouTube.
  const video = await ctx.runQuery(api.videos.get, { id: videoId });
  if (!video) throw new Error("Video not found or not owned by caller");
  if (!video.publishedVideoId) {
    throw new Error("Video has not been published to YouTube yet");
  }

  // 2. Load the user record (includes OAuth tokens).
  const user = await ctx.runQuery(api.users.current, {});
  if (!user) throw new Error("Authenticated user not found in database");
  if (!user.youtubeConnected) throw new Error("YouTube account is not connected");

  const youtubeVideoId = video.publishedVideoId;

  // Use the video's publish date as startDate; fall back to 30 days ago.
  const startDate = video.publishedAt
    ? toYYYYMMDD(video.publishedAt)
    : toYYYYMMDD(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const endDate = toYYYYMMDD(Date.now());

  // 3. Ensure we hold a valid access token.
  let accessToken: string;
  try {
    accessToken = await ensureValidToken(ctx, user);
  } catch (err: any) {
    if (err.code === 401) {
      await ctx.runMutation(internal.videoAnalytics.internalSetYoutubeOAuthStatus, {
        userId: user._id,
        status: "token_expired",
      });
    }
    throw err;
  }

  // 4. Core metrics — safe on all channel reports.
  const CORE_METRICS = [
    "views",
    "estimatedMinutesWatched",
    "averageViewDuration",
    "likes",
    "comments",
    "subscribersGained",
  ].join(",");

  let metrics: Record<string, number> | null;
  try {
    metrics = await callAnalyticsAPI(accessToken, youtubeVideoId, startDate, endDate, CORE_METRICS);
  } catch (err: any) {
    if (err.code === 401) {
      await ctx.runMutation(internal.videoAnalytics.internalSetYoutubeOAuthStatus, {
        userId: user._id,
        status: "token_expired",
      });
    }
    throw err;
  }

  if (!metrics) return null;

  const analyticsRow = {
    userId: user._id as Id<"users">,
    videoId,
    youtubeVideoId,
    fetchedAt: Date.now(),
    views:
      metrics["views"] !== undefined ? Math.round(metrics["views"]) : undefined,
    watchTimeMinutes: metrics["estimatedMinutesWatched"],
    avgViewDurationSec: metrics["averageViewDuration"],
    likes:
      metrics["likes"] !== undefined ? Math.round(metrics["likes"]) : undefined,
    comments:
      metrics["comments"] !== undefined
        ? Math.round(metrics["comments"])
        : undefined,
    subscribersGained:
      metrics["subscribersGained"] !== undefined
        ? Math.round(metrics["subscribersGained"])
        : undefined,
  };

  // 5. Persist via upsert (same-day rows are merged, not duplicated).
  await ctx.runMutation(internal.videoAnalytics.upsertAnalytics, analyticsRow);

  return analyticsRow;
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Fetches YouTube Analytics for a single video and stores the result.
 * The calling user must own the video; the video must already be published.
 */
export const fetchForVideo = action({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args): Promise<Record<string, unknown> | null> => {
    return doFetchForVideo(ctx, args.videoId);
  },
});

/**
 * Fetches analytics for every published video owned by the current user.
 * Requests are made sequentially to avoid YouTube API quota spikes.
 * Returns an array of per-video results: { videoId, ok, data?, error? }.
 */
export const fetchForUser = action({
  args: {},
  handler: async (ctx) => {
    const videos = await ctx.runQuery(api.videos.list, {});
    const published = (videos ?? []).filter(
      (vid: any) => vid.status === "published" && vid.publishedVideoId,
    );

    const results: {
      videoId: string;
      ok: boolean;
      data?: Record<string, unknown> | null;
      error?: string;
    }[] = [];

    for (const vid of published) {
      try {
        const data = await doFetchForVideo(ctx, vid._id as Id<"videos">);
        results.push({ videoId: vid._id, ok: true, data });
      } catch (err: any) {
        console.error(`Analytics fetch failed for video ${vid._id}:`, err);
        results.push({ videoId: vid._id, ok: false, error: err.message ?? String(err) });
      }
    }

    return results;
  },
});

/**
 * Fetches channel-level aggregate stats for the last 28 days.
 * Metrics: views, estimatedMinutesWatched, subscribersGained, subscribersLost.
 * Useful for dashboard summary cards that don't need per-video breakdown.
 */
export const fetchChannelStats = action({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.runQuery(api.users.current, {});
    if (!user) throw new Error("Authenticated user not found in database");
    if (!user.youtubeConnected) throw new Error("YouTube account is not connected");

    let accessToken: string;
    try {
      accessToken = await ensureValidToken(ctx, user);
    } catch (err: any) {
      if (err.code === 401) {
        await ctx.runMutation(internal.videoAnalytics.internalSetYoutubeOAuthStatus, {
          userId: user._id,
          status: "token_expired",
        });
      }
      throw err;
    }

    const endDate = toYYYYMMDD(Date.now());
    const startDate = toYYYYMMDD(Date.now() - 28 * 24 * 60 * 60 * 1000);

    const params = new URLSearchParams({
      ids: "channel==MINE",
      metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost",
      startDate,
      endDate,
    });

    const res = await fetch(
      `https://youtubeanalytics.googleapis.com/v2/reports?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (res.status === 401) {
      await ctx.runMutation(internal.videoAnalytics.internalSetYoutubeOAuthStatus, {
        userId: user._id,
        status: "token_expired",
      });
      throw new Error("YouTube Analytics token expired (401)");
    }

    if (res.status === 403) {
      console.error("YouTube Analytics channel stats 403 — quota exhausted or missing scope");
      return null;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`YouTube Analytics API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      columnHeaders?: { name: string }[];
      rows?: number[][];
    };

    if (!data.rows || data.rows.length === 0) return null;

    const headers = (data.columnHeaders ?? []).map((h) => h.name);
    const row = data.rows[0];
    const result = Object.fromEntries(headers.map((h, i) => [h, row[i]]));

    return {
      views: result["views"],
      estimatedMinutesWatched: result["estimatedMinutesWatched"],
      subscribersGained: result["subscribersGained"],
      subscribersLost: result["subscribersLost"],
      periodStart: startDate,
      periodEnd: endDate,
    };
  },
});
