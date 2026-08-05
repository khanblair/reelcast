import { v } from "convex/values";
import { query } from "../_generated/server";

/**
 * List all failed jobs across all users, newest first (by startedAt).
 */
export const listFailed = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const failed = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .order("desc")
      .take(limit);

    return Promise.all(
      failed.map(async (job) => {
        const user = await ctx.db.get(job.userId);
        const video = await ctx.db.get(job.videoId);
        return {
          _id: job._id,
          _creationTime: job._creationTime,
          type: job.type,
          status: job.status,
          error: job.error,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          userEmail: user?.email ?? "unknown",
          videoTitle: video?.title ?? "(deleted)",
        };
      }),
    );
  },
});

/**
 * List the most recent jobs across all users regardless of status.
 */
export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const jobs = await ctx.db.query("jobs").order("desc").take(limit);

    return Promise.all(
      jobs.map(async (job) => {
        const user = await ctx.db.get(job.userId);
        const video = await ctx.db.get(job.videoId);
        return {
          _id: job._id,
          _creationTime: job._creationTime,
          type: job.type,
          status: job.status,
          error: job.error,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          userEmail: user?.email ?? "unknown",
          videoTitle: video?.title ?? "(deleted)",
        };
      }),
    );
  },
});
