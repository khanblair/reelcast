"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api } from "../_generated/api";

export const triggerPublish = action({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // Mark video as publishing first so the UI updates immediately
    await ctx.runMutation(api.videos.updateStatus, {
      id: args.videoId,
      status: "publishing",
    });

    // jobs.create handles scheduling processPublishJob internally
    await ctx.runMutation(api.jobs.create, {
      videoId: args.videoId,
      type: "publish",
    });
  },
});
