"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { getCurrentUserOrThrow } from "../lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Private helpers — take accessToken directly so they're callable from
// multiple action handlers without going through a sub-action invocation.
// Return { status, data } so handlers can branch on HTTP 401.
// ---------------------------------------------------------------------------

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

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) return { status: res.status, data: [] };

  const json = (await res.json()) as {
    items?: {
      id: string;
      snippet?: {
        title?: string;
        channelTitle?: string;
        tags?: string[];
        publishedAt?: string;
      };
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

async function doSearchByKeyword(
  accessToken: string,
  keyword: string,
  maxResults: number,
): Promise<{ status: number; data: SearchResult[] }> {
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const params = new URLSearchParams({
    part: "snippet",
    q: keyword,
    type: "video",
    order: "viewCount",
    publishedAfter: sevenDaysAgo,
    maxResults: String(maxResults),
  });

  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!res.ok) return { status: res.status, data: [] };

  const json = (await res.json()) as {
    items?: {
      id?: { videoId?: string };
      snippet?: {
        title?: string;
        channelTitle?: string;
        description?: string;
        publishedAt?: string;
        thumbnails?: { medium?: { url?: string } };
      };
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

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

export const getTrendingTopics = action({
  args: {
    categoryId: v.optional(v.string()),
    regionCode: v.optional(v.string()),
    maxResults: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<TrendingVideo[]> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user?.youtubeAccessToken) return [];

    try {
      const { status, data } = await fetchTrendingVideos(
        user.youtubeAccessToken,
        args,
      );

      if (status === 401) {
        await ctx.runMutation(internal.users.internalSetYoutubeOAuthStatus, {
          userId: user._id,
          status: "token_expired",
        });
        return [];
      }

      if (data.length > 0) {
        await ctx.runMutation(internal.admin.quota.addQuotaUsage, {
          userId: user._id,
          units: data.length, // videos.list: 1 unit per video
        });
      }

      return data;
    } catch (err) {
      console.error("[getTrendingTopics] error:", err);
      return [];
    }
  },
});

export const searchByKeyword = action({
  args: {
    keyword: v.string(),
    maxResults: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchResult[]> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user?.youtubeAccessToken) return [];

    try {
      const { status, data } = await doSearchByKeyword(
        user.youtubeAccessToken,
        args.keyword,
        args.maxResults ?? 25,
      );

      if (status === 401) {
        await ctx.runMutation(internal.users.internalSetYoutubeOAuthStatus, {
          userId: user._id,
          status: "token_expired",
        });
        return [];
      }

      await ctx.runMutation(internal.admin.quota.addQuotaUsage, {
        userId: user._id,
        units: 100, // search.list costs 100 quota units
      });

      return data;
    } catch (err) {
      console.error("[searchByKeyword] error:", err);
      return [];
    }
  },
});

export const getContentGaps = action({
  args: {
    competitorChannelIds: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    gaps: string[];
    competitorTopics: string[];
    userTopics: string[];
  }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user?.youtubeAccessToken) {
      return { gaps: [], competitorTopics: [], userTopics: [] };
    }

    // 1. Collect all tags from the user's published videos
    const videos = await ctx.runQuery(api.videos.list, {});
    const userTopics: string[] = Array.from(
      new Set(
        videos
          .filter((vid) => vid.status === "published")
          .flatMap((vid) => [
            ...(vid.tags ?? []),
            ...(vid.aiTags ?? []),
          ]),
      ),
    );

    // 2. Fetch trending topics
    let trendingTags: string[] = [];
    try {
      const { status, data: trending } = await fetchTrendingVideos(
        user.youtubeAccessToken,
        { maxResults: 25 },
      );

      if (status === 401) {
        await ctx.runMutation(internal.users.internalSetYoutubeOAuthStatus, {
          userId: user._id,
          status: "token_expired",
        });
        return { gaps: [], competitorTopics: [], userTopics };
      }

      if (trending.length > 0) {
        await ctx.runMutation(internal.admin.quota.addQuotaUsage, {
          userId: user._id,
          units: trending.length,
        });
        trendingTags = Array.from(
          new Set(trending.flatMap((t) => t.tags)),
        );
      }
    } catch (err) {
      console.error("[getContentGaps] trending fetch error:", err);
    }

    // 3. Fetch recent videos from competitor channels (if provided)
    const competitorTopics: string[] = [];
    for (const channelId of args.competitorChannelIds ?? []) {
      try {
        const params = new URLSearchParams({
          part: "snippet",
          channelId,
          type: "video",
          order: "date",
          maxResults: "10",
        });
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/search?${params.toString()}`,
          { headers: { Authorization: `Bearer ${user.youtubeAccessToken}` } },
        );

        if (res.status === 401) {
          await ctx.runMutation(internal.users.internalSetYoutubeOAuthStatus, {
            userId: user._id,
            status: "token_expired",
          });
          break;
        }

        if (res.ok) {
          const json = (await res.json()) as {
            items?: { snippet?: { title?: string } }[];
          };
          const titles = (json.items ?? [])
            .map((item) => item.snippet?.title ?? "")
            .filter(Boolean);
          competitorTopics.push(...titles);
          await ctx.runMutation(internal.admin.quota.addQuotaUsage, {
            userId: user._id,
            units: 100,
          });
        }
      } catch (err) {
        console.error(
          `[getContentGaps] competitor channel ${channelId} error:`,
          err,
        );
      }
    }

    // 4. Compute gaps: trending tags not already covered by the user
    const userTopicsLower = new Set(userTopics.map((t) => t.toLowerCase()));
    const gaps = trendingTags.filter(
      (tag) => !userTopicsLower.has(tag.toLowerCase()),
    );

    return { gaps, competitorTopics, userTopics };
  },
});

export const computeOpportunityScore = action({
  args: {
    topic: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    topic: string;
    score: number;
    sampleVideos: SearchResult[];
  }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user?.youtubeAccessToken) {
      return { topic: args.topic, score: 0, sampleVideos: [] };
    }

    try {
      // Step 1: search for the topic
      const { status: searchStatus, data: searchResults } =
        await doSearchByKeyword(user.youtubeAccessToken, args.topic, 10);

      if (searchStatus === 401) {
        await ctx.runMutation(internal.users.internalSetYoutubeOAuthStatus, {
          userId: user._id,
          status: "token_expired",
        });
        return { topic: args.topic, score: 0, sampleVideos: [] };
      }

      await ctx.runMutation(internal.admin.quota.addQuotaUsage, {
        userId: user._id,
        units: 100,
      });

      if (!searchResults.length) {
        return { topic: args.topic, score: 0, sampleVideos: [] };
      }

      // Step 2: fetch statistics for those videos
      const videoIds = searchResults
        .map((r) => r.videoId)
        .filter(Boolean)
        .join(",");

      const statsRes = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}`,
        { headers: { Authorization: `Bearer ${user.youtubeAccessToken}` } },
      );

      let avgViewCount = 0;
      if (statsRes.ok) {
        const statsJson = (await statsRes.json()) as {
          items?: { statistics?: { viewCount?: string } }[];
        };
        const viewCounts = (statsJson.items ?? []).map((item) =>
          parseInt(item.statistics?.viewCount ?? "0", 10),
        );
        await ctx.runMutation(internal.admin.quota.addQuotaUsage, {
          userId: user._id,
          units: viewCounts.length, // videos.list: 1 unit per video
        });
        if (viewCounts.length > 0) {
          avgViewCount =
            viewCounts.reduce((a, b) => a + b, 0) / viewCounts.length;
        }
      }

      // Score formula: (avgViewCount / (videoCount * 1000)) * 10, clamped to 1–100
      const rawScore =
        (avgViewCount / (searchResults.length * 1000)) * 10;
      const score = Math.min(100, Math.max(1, Math.round(rawScore)));

      return {
        topic: args.topic,
        score,
        sampleVideos: searchResults.slice(0, 3),
      };
    } catch (err) {
      console.error("[computeOpportunityScore] error:", err);
      return { topic: args.topic, score: 0, sampleVideos: [] };
    }
  },
});
