import { query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

export const getDashboardStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

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
