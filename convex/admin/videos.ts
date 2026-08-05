import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

/**
 * List all videos across all users, newest first, with user email joined.
 * Optional status filter.
 */
export const listAll = query({
  args: {
    limit: v.optional(v.number()),
    status: v.optional(v.union(
      v.literal("draft"), v.literal("queued"), v.literal("generating"),
      v.literal("ready"), v.literal("scheduled"), v.literal("publishing"),
      v.literal("published"), v.literal("failed"),
    )),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const allVideos = await ctx.db.query("videos").order("desc").take(limit);

    const filtered = args.status !== undefined
      ? allVideos.filter((v) => v.status === args.status)
      : allVideos;

    return Promise.all(
      filtered.map(async (video) => {
        const user = await ctx.db.get(video.userId);
        return {
          _id: video._id,
          _creationTime: video._creationTime,
          title: video.title,
          status: video.status,
          userId: video.userId,
          userEmail: user?.email ?? "unknown",
          userName: user?.name,
          rawFileSize: video.rawFileSize,
          publishedAt: video.publishedAt,
          scheduledPublishAt: video.scheduledPublishAt,
          publishedVideoId: video.publishedVideoId,
        };
      }),
    );
  },
});

/**
 * Admin hard-delete any video — no ownership check.
 * Protected at the Next.js layer.
 */
export const adminDelete = mutation({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.videoId);
  },
});
