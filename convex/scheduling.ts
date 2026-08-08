import { v } from "convex/values";
import { query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

const MIN_DATA_POINTS = 5; // Require at least 5 published videos with analytics before suggesting

// Returns the top 3 publish hours (UTC) based on historical CTR and views,
// or null if there is insufficient data.
export const getSuggestedTimes = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) return null;

    // Fetch all published videos with both analytics and a publish timestamp
    const publishedVideos = await ctx.db
      .query("videos")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "published"))
      .collect();

    if (publishedVideos.length < MIN_DATA_POINTS) {
      return { suggestedTimes: null, reason: "not_enough_data", videosNeeded: MIN_DATA_POINTS };
    }

    // Fetch analytics for published videos
    const analyticsMap: Record<string, { views: number; ctr: number }> = {};
    for (const vid of publishedVideos) {
      const analytics = await ctx.db
        .query("videoAnalytics")
        .withIndex("by_video", (q) => q.eq("videoId", vid._id))
        .order("desc")
        .first();
      if (analytics) {
        analyticsMap[vid._id] = {
          views: analytics.views ?? 0,
          ctr: analytics.ctr ?? 0,
        };
      }
    }

    // Bucket performance by publish hour (UTC) — keep EAT (UTC+3) offset in mind for display
    const hourBuckets: Record<number, { totalViews: number; totalCtr: number; count: number }> = {};
    for (const vid of publishedVideos) {
      if (!vid.publishedAt) continue;
      const analytics = analyticsMap[vid._id];
      if (!analytics) continue;

      const hourUtc = new Date(vid.publishedAt).getUTCHours();
      if (!hourBuckets[hourUtc]) {
        hourBuckets[hourUtc] = { totalViews: 0, totalCtr: 0, count: 0 };
      }
      hourBuckets[hourUtc].totalViews += analytics.views;
      hourBuckets[hourUtc].totalCtr += analytics.ctr;
      hourBuckets[hourUtc].count++;
    }

    const videosWithHourAndAnalytics = Object.values(hourBuckets).reduce(
      (s, b) => s + b.count, 0
    );
    if (videosWithHourAndAnalytics < MIN_DATA_POINTS) {
      return { suggestedTimes: null, reason: "not_enough_data", videosNeeded: MIN_DATA_POINTS };
    }

    // Score each hour by normalised CTR (60% weight) + normalised views (40% weight)
    const maxCtr = Math.max(...Object.values(hourBuckets).map((b) => b.totalCtr / b.count));
    const maxViews = Math.max(...Object.values(hourBuckets).map((b) => b.totalViews / b.count));

    const scored = Object.entries(hourBuckets)
      .map(([hourStr, bucket]) => {
        const hour = parseInt(hourStr);
        const avgCtr = bucket.totalCtr / bucket.count;
        const avgViews = bucket.totalViews / bucket.count;
        const score =
          (maxCtr > 0 ? (avgCtr / maxCtr) * 0.6 : 0) +
          (maxViews > 0 ? (avgViews / maxViews) * 0.4 : 0);
        return {
          hourUtc: hour,
          hourEat: (hour + 3) % 24, // EAT = UTC+3
          avgCtr: Math.round(avgCtr * 1000) / 1000,
          avgViews: Math.round(avgViews),
          sampleSize: bucket.count,
          confidence: bucket.count >= 3 ? "high" : "low",
          score: Math.round(score * 100) / 100,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return {
      suggestedTimes: scored,
      reason: "analytics",
      totalVideosAnalysed: videosWithHourAndAnalytics,
    };
  },
});
