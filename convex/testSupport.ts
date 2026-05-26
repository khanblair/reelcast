import { mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";

export const runTestJob = mutation({
  args: {},
  handler: async (ctx) => {
    // 1. Find or create a test user
    let user = await ctx.db.query("users").first();
    if (!user) {
      const userId = await ctx.db.insert("users", {
        clerkId: "test_clerk_id",
        email: "test@example.com",
        name: "Test User",
        youtubeConnected: false,
      });
      user = await ctx.db.get(userId);
    }
    
    if (!user) {
      throw new Error("Failed to find or create test user");
    }
    
    // 2. Insert test video (using the Cloudinary URL we successfully uploaded)
    const videoId = await ctx.db.insert("videos", {
      userId: user._id,
      title: "Forex Test Video",
      rawFileKey: "https://res.cloudinary.com/dxegxiteh/video/upload/v1779522948/tevly1u0mqxjoft4cck7.mp4",
      rawFileSize: 2536841,
      status: "queued",
    });

    // 3. Insert job
    const jobId = await ctx.db.insert("jobs", {
      userId: user._id,
      videoId,
      type: "generation",
      status: "pending",
    });

    // 4. Schedule the generation job
    await ctx.scheduler.runAfter(0, api.scheduled.runGeneration.processGenerationJob, {
      jobId,
      videoId,
    });

    return { videoId, jobId };
  }
});

export const getVideo = query({
  args: { id: v.id("videos") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  }
});

export const getJob = query({
  args: { id: v.id("jobs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  }
});
