import { v } from "convex/values";
import { query, internalQuery } from "./_generated/server";

// Internal query: fetch recent videoAnalytics rows for a user (for AI context)
export const getRecentForUser = internalQuery({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("videoAnalytics")
      .withIndex("by_user_fetched", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(args.limit);
  },
});

// Internal query: best-effort latest analytics snapshot (views) for a set of
// videos. Used by the weekly digest — many users will have zero rows for a
// given video (analytics may not have been fetched yet), which is fine; those
// videos are simply omitted from the result rather than causing an error.
export const internalGetLatestForVideos = internalQuery({
  args: { videoIds: v.array(v.id("videos")) },
  handler: async (ctx, args) => {
    const results: Array<{ videoId: string; views?: number }> = [];
    for (const videoId of args.videoIds) {
      const rows = await ctx.db
        .query("videoAnalytics")
        .withIndex("by_video", (q) => q.eq("videoId", videoId))
        .collect();
      if (rows.length === 0) continue;
      const latest = rows.reduce((best, r) => (r.fetchedAt > best.fetchedAt ? r : best));
      results.push({ videoId, views: latest.views });
    }
    return results;
  },
});

export const getDashboardStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();

    if (!user) return null;

    const videos = await ctx.db
      .query("videos")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    // 1. Status Distribution
    const statusCounts = videos.reduce((acc: Record<string, number>, video) => {
      acc[video.status] = (acc[video.status] || 0) + 1;
      return acc;
    }, {});

    const statusData = Object.keys(statusCounts).map(status => ({
      name: status.charAt(0).toUpperCase() + status.slice(1),
      count: statusCounts[status]
    }));

    // 2. Videos over time (last 7 days)
    const now = Date.now();
    const msInDay = 24 * 60 * 60 * 1000;
    const last7Days = Array.from({ length: 7 }).map((_, i) => {
      const date = new Date(now - (6 - i) * msInDay);
      return {
        date: `${date.getMonth() + 1}/${date.getDate()}`,
        timestamp: date.setHours(0, 0, 0, 0),
        count: 0
      };
    });

    videos.forEach(video => {
      const videoDate = new Date(video._creationTime).setHours(0, 0, 0, 0);
      const dayIndex = last7Days.findIndex(day => day.timestamp === videoDate);
      if (dayIndex !== -1) {
        last7Days[dayIndex].count++;
      }
    });

    // 3. Total stats
    const totalStorage = videos.reduce((sum, video) => sum + (video.rawFileSize || 0), 0);
    const totalDuration = videos.reduce((sum, video) => sum + (video.duration || 0), 0);

    return {
      statusData,
      timelineData: last7Days,
      totalVideos: videos.length,
      totalStorageBytes: totalStorage,
      totalDurationSeconds: totalDuration,
    };
  }
});
