// Port of convex/actions/contentIntelligence.ts (getTrendingTopics, searchByKeyword, getContentGaps).
// Export ONLY rpc definitions from this file. computeOpportunityScore had no caller in the UI and is
// not ported.
//
// Runtime is bounded: every YouTube call has a 15s timeout, content-gaps fans competitor lookups out in
// parallel (max 5 channels) instead of the Convex sequential unbounded loop. Quota is recorded with
// addYoutubeQuota (atomic) using the same unit costs as Convex.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/client";
import { videos, youtubeChannels } from "@/db/schema";
import { addYoutubeQuota } from "@/server/lib/youtubeQuota";
import { getPrimaryChannelRow, getValidAccessToken } from "@/server/lib/youtube/tokens";
import { safeMessage } from "@/server/lib/generation/common";
import { action } from "../../rpc/define";

interface TrendingVideo {
  videoId: string;
  title: string;
  channelTitle: string;
  viewCount: number;
  likeCount: number;
  tags: string[];
  publishedAt: string;
}

interface SearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
}

const YT = "https://www.googleapis.com/youtube/v3";
const YT_TIMEOUT_MS = 15_000;
const MAX_COMPETITORS = 5;
const MAX_USER_VIDEOS = 1000;

/** The caller's YouTube access token (refreshed if needed), or null when not connected / unusable. */
async function accessTokenFor(db: DbLike, userId: string): Promise<{ accessToken: string; rowId: string } | null> {
  const row = await getPrimaryChannelRow(db, userId);
  if (!row) return null;
  try {
    const { accessToken } = await getValidAccessToken(db, row.id);
    return { accessToken, rowId: row.id };
  } catch (e) {
    console.error("[contentIntelligence] no usable YouTube token:", safeMessage(e, 120));
    return null;
  }
}

/** A 401 means the token is dead: record it so the UI prompts a reconnect. */
async function markTokenExpired(db: DbLike, userId: string, rowId: string): Promise<void> {
  await db
    .update(youtubeChannels)
    .set({ oauthStatus: "token_expired", updatedAt: new Date() })
    .where(and(eq(youtubeChannels.id, rowId), eq(youtubeChannels.userId, userId)));
}

async function ytGet(path: string, params: URLSearchParams, accessToken: string): Promise<Response> {
  return fetch(`${YT}/${path}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(YT_TIMEOUT_MS),
  });
}

async function fetchTrendingVideos(
  accessToken: string,
  opts: { categoryId?: string; regionCode?: string; maxResults?: number },
): Promise<{ status: number; data: TrendingVideo[] }> {
  const params = new URLSearchParams({
    part: "snippet,statistics",
    chart: "mostPopular",
    regionCode: opts.regionCode ?? "US",
    maxResults: String(opts.maxResults ?? 25),
  });
  if (opts.categoryId) params.set("videoCategoryId", opts.categoryId);

  const res = await ytGet("videos", params, accessToken);
  if (!res.ok) return { status: res.status, data: [] };

  const json = (await res.json()) as {
    items?: {
      id: string;
      snippet?: { title?: string; channelTitle?: string; tags?: string[]; publishedAt?: string };
      statistics?: { viewCount?: string; likeCount?: string };
    }[];
  };
  const data: TrendingVideo[] = (json.items ?? []).map((item) => ({
    videoId: item.id,
    title: item.snippet?.title ?? "",
    channelTitle: item.snippet?.channelTitle ?? "",
    viewCount: parseInt(item.statistics?.viewCount ?? "0", 10),
    likeCount: parseInt(item.statistics?.likeCount ?? "0", 10),
    tags: item.snippet?.tags ?? [],
    publishedAt: item.snippet?.publishedAt ?? "",
  }));
  return { status: res.status, data };
}

async function doSearchByKeyword(accessToken: string, keyword: string, maxResults: number): Promise<{ status: number; data: SearchResult[] }> {
  const params = new URLSearchParams({
    part: "snippet",
    q: keyword,
    type: "video",
    order: "viewCount",
    publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    maxResults: String(maxResults),
  });
  const res = await ytGet("search", params, accessToken);
  if (!res.ok) return { status: res.status, data: [] };

  const json = (await res.json()) as {
    items?: {
      id?: { videoId?: string };
      snippet?: { title?: string; channelTitle?: string; description?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string } } };
    }[];
  };
  const data: SearchResult[] = (json.items ?? []).map((item) => ({
    videoId: item.id?.videoId ?? "",
    title: item.snippet?.title ?? "",
    channelTitle: item.snippet?.channelTitle ?? "",
    description: item.snippet?.description ?? "",
    publishedAt: item.snippet?.publishedAt ?? "",
    thumbnailUrl: item.snippet?.thumbnails?.medium?.url ?? "",
  }));
  return { status: res.status, data };
}

export const getTrendingTopics = action({
  input: z.object({
    categoryId: z.string().regex(/^\d{1,3}$/).optional(),
    regionCode: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    maxResults: z.number().int().min(1).max(50).optional(),
  }),
  handler: async (ctx, args): Promise<TrendingVideo[]> => {
    const { db, userId } = ctx;
    const tok = await accessTokenFor(db, userId);
    if (!tok) return [];
    try {
      const { status, data } = await fetchTrendingVideos(tok.accessToken, { ...args, regionCode: args.regionCode?.toUpperCase() });
      if (status === 401) {
        await markTokenExpired(db, userId, tok.rowId);
        return [];
      }
      if (data.length > 0) await addYoutubeQuota(db, userId, data.length); // videos.list: 1 unit per video
      return data;
    } catch (e) {
      console.error("[getTrendingTopics] error:", safeMessage(e, 120));
      return [];
    }
  },
});

export const searchByKeyword = action({
  input: z.object({
    keyword: z.string().trim().min(1).max(200),
    maxResults: z.number().int().min(1).max(50).optional(),
  }),
  handler: async (ctx, args): Promise<SearchResult[]> => {
    const { db, userId } = ctx;
    const tok = await accessTokenFor(db, userId);
    if (!tok) return [];
    try {
      const { status, data } = await doSearchByKeyword(tok.accessToken, args.keyword, args.maxResults ?? 25);
      if (status === 401) {
        await markTokenExpired(db, userId, tok.rowId);
        return [];
      }
      await addYoutubeQuota(db, userId, 100); // search.list costs 100 quota units
      return data;
    } catch (e) {
      console.error("[searchByKeyword] error:", safeMessage(e, 120));
      return [];
    }
  },
});

export const getContentGaps = action({
  input: z.object({
    competitorChannelIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)).max(50).optional(),
  }),
  handler: async (ctx, args): Promise<{ gaps: string[]; competitorTopics: string[]; userTopics: string[] }> => {
    const { db, userId } = ctx;
    const tok = await accessTokenFor(db, userId);
    if (!tok) return { gaps: [], competitorTopics: [], userTopics: [] };

    // 1. Tags from the user's published videos.
    const published = await db
      .select({ tags: videos.tags, aiTags: videos.aiTags })
      .from(videos)
      .where(and(eq(videos.userId, userId), eq(videos.status, "published")))
      .limit(MAX_USER_VIDEOS);
    const userTopics = Array.from(new Set(published.flatMap((v) => [...(v.tags ?? []), ...(v.aiTags ?? [])])));

    // 2. Trending tags.
    let trendingTags: string[] = [];
    try {
      const { status, data: trending } = await fetchTrendingVideos(tok.accessToken, { maxResults: 25 });
      if (status === 401) {
        await markTokenExpired(db, userId, tok.rowId);
        return { gaps: [], competitorTopics: [], userTopics };
      }
      if (trending.length > 0) {
        await addYoutubeQuota(db, userId, trending.length);
        trendingTags = Array.from(new Set(trending.flatMap((t) => t.tags)));
      }
    } catch (e) {
      console.error("[getContentGaps] trending fetch error:", safeMessage(e, 120));
    }

    // 3. Recent uploads of competitor channels (parallel, capped).
    const competitorTopics: string[] = [];
    let expired = false;
    const channelIds = (args.competitorChannelIds ?? []).slice(0, MAX_COMPETITORS);
    const settled = await Promise.allSettled(
      channelIds.map(async (channelId) => {
        const params = new URLSearchParams({ part: "snippet", channelId, type: "video", order: "date", maxResults: "10" });
        const res = await ytGet("search", params, tok.accessToken);
        if (res.status === 401) {
          expired = true;
          return [] as string[];
        }
        if (!res.ok) return [] as string[];
        const json = (await res.json()) as { items?: { snippet?: { title?: string } }[] };
        await addYoutubeQuota(db, userId, 100);
        return (json.items ?? []).map((i) => i.snippet?.title ?? "").filter(Boolean);
      }),
    );
    for (const r of settled) {
      if (r.status === "fulfilled") competitorTopics.push(...r.value);
      else console.error("[getContentGaps] competitor lookup failed:", safeMessage(r.reason, 120));
    }
    if (expired) await markTokenExpired(db, userId, tok.rowId);

    // 4. Gaps: trending tags the user has not covered.
    const have = new Set(userTopics.map((t) => t.toLowerCase()));
    const gaps = trendingTags.filter((tag) => !have.has(tag.toLowerCase()));
    return { gaps, competitorTopics, userTopics };
  },
});
