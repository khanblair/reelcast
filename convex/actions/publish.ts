"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api } from "../_generated/api";

export const triggerPublish = action({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // 1. Create a publish job
    const jobId = await ctx.runMutation(api.jobs.create, {
      videoId: args.videoId,
      type: "publish",
    });

    // 2. Mark video as publishing
    await ctx.runMutation(api.videos.updateStatus, {
      id: args.videoId,
      status: "publishing",
    });

    // 3. Schedule the publish job to run immediately
    await ctx.scheduler.runAfter(0, api.scheduled.runPublish.processPublishJob, {
      jobId,
      videoId: args.videoId,
    });
  },
});
