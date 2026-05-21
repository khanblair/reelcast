import { v } from "convex/values";
import { action } from "../_generated/server";
import { api } from "../_generated/api";

export const processGenerationJob = action({
  args: { jobId: v.id("jobs"), videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // 1. Mark job as processing
    await ctx.runMutation(api.jobs.updateStatus, {
      id: args.jobId,
      status: "processing",
    });

    try {
      // 2. Simulate AI API call delay (10 seconds)
      await new Promise((resolve) => setTimeout(resolve, 10000));

      // 3. Mock AI results
      const mockTitle = "10 Secrets to Better Programming [2026]";
      const mockDescription = "In this video, we dive deep into the best practices for modern web development and system design.\n\nSubscribe for more content!";
      const mockTags = ["programming", "web development", "coding", "software engineering", "tech"];

      // 4. Update the video with the AI metadata
      await ctx.runMutation(api.videos.updateStatus, {
        id: args.videoId,
        status: "ready",
      });

      // We need a mutation to update video metadata
      await ctx.runMutation(api.videos.updateMetadata, {
        id: args.videoId,
        aiTitle: mockTitle,
        aiDescription: mockDescription,
        aiTags: mockTags,
      });

      // 5. Mark job completed
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
