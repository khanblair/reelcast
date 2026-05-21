import { v } from "convex/values";
import { action } from "../_generated/server";
import { api } from "../_generated/api";

export const processPublishJob = action({
  args: { jobId: v.id("jobs"), videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // 1. Mark job as processing
    await ctx.runMutation(api.jobs.updateStatus, {
      id: args.jobId,
      status: "processing",
    });

    try {
      // 2. Simulate YouTube API call delay
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // 3. Update the video with the mock YouTube Video ID
      const mockYouTubeId = "dQw4w9WgXcQ"; // Never gonna give you up
      await ctx.runMutation(api.videos.updateStatus, {
        id: args.videoId,
        status: "published",
      });
      
      // We need a mutation to set published metadata
      await ctx.runMutation(api.videos.setPublishedData, {
        id: args.videoId,
        publishedVideoId: mockYouTubeId,
        publishedAt: Date.now(),
      });

      // 4. Mark job completed
      await ctx.runMutation(api.jobs.updateStatus, {
        id: args.jobId,
        status: "completed",
      });
    } catch (e: any) {
      // Mark job failed
      await ctx.runMutation(api.jobs.updateStatus, {
        id: args.jobId,
        status: "failed",
        error: e.message,
      });
      
      await ctx.runMutation(api.videos.updateStatus, {
        id: args.videoId,
        status: "failed",
      });
    }
  },
});
