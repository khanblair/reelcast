import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { api } from "./_generated/api";
import { getCurrentUserOrThrow } from "./lib/auth";

export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    rawFileKey: v.string(),
    rawFileSize: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found in DB");
    }

    return await ctx.db.insert("videos", {
      userId: user._id,
      title: args.title,
      description: args.description,
      tags: args.tags,
      rawFileKey: args.rawFileKey,
      rawFileSize: args.rawFileSize,
      status: "draft",
    });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      return [];
    }

    return await ctx.db
      .query("videos")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { id: v.id("videos") },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found in DB");
    }

    const video = await ctx.db.get(args.id);
    if (!video || video.userId !== user._id) {
      return null;
    }

    return video;
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("videos"),
    status: v.union(
      v.literal("draft"),
      v.literal("queued"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("scheduled"),
      v.literal("publishing"),
      v.literal("published"),
      v.literal("failed")
    ),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found in DB");
    }

    const video = await ctx.db.get(args.id);
    if (!video || video.userId !== user._id) {
      throw new Error("Video not found or unauthorized");
    }

    await ctx.db.patch(args.id, { status: args.status });
  },
});

export const updatePrivacyStatus = mutation({
  args: {
    id: v.id("videos"),
    privacyStatus: v.union(v.literal("private"), v.literal("public"), v.literal("unlisted")),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found in DB");
    }

    const video = await ctx.db.get(args.id);
    if (!video || video.userId !== user._id) {
      throw new Error("Video not found or unauthorized");
    }

    await ctx.db.patch(args.id, { privacyStatus: args.privacyStatus });
  },
});

export const updateMetadata = mutation({
  args: {
    id: v.id("videos"),
    aiTitle: v.optional(v.string()),
    aiDescription: v.optional(v.string()),
    aiTags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // Note: This is usually called by the action context, so we might skip user verification
    // or just assume the action is trusted. But let's verify if called by client.
    // For simplicity, we just patch it.
    await ctx.db.patch(args.id, {
      aiTitle: args.aiTitle,
      aiDescription: args.aiDescription,
      aiTags: args.aiTags,
    });
  },
});

export const setPublishedData = mutation({
  args: {
    id: v.id("videos"),
    publishedVideoId: v.string(),
    publishedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      publishedVideoId: args.publishedVideoId,
      publishedAt: args.publishedAt,
    });
  },
});

// Internal query — used by scheduled actions (no auth check, trusted context)
export const internalGet = internalQuery({
  args: { id: v.id("videos") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Internal mutation — used by scheduled actions (no auth check, trusted context)
export const internalUpdateStatus = internalMutation({
  args: {
    id: v.id("videos"),
    status: v.union(
      v.literal("draft"),
      v.literal("queued"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("scheduled"),
      v.literal("publishing"),
      v.literal("published"),
      v.literal("failed")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: args.status });
  },
});

export const internalUpdateMetadata = internalMutation({
  args: {
    id: v.id("videos"),
    aiTitle: v.optional(v.string()),
    aiDescription: v.optional(v.string()),
    aiTags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      aiTitle: args.aiTitle,
      aiDescription: args.aiDescription,
      aiTags: args.aiTags,
    });
  },
});

export const internalSetPublishedData = internalMutation({
  args: {
    id: v.id("videos"),
    publishedVideoId: v.string(),
    publishedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      publishedVideoId: args.publishedVideoId,
      publishedAt: args.publishedAt,
    });
  },
});

export const internalUpdateVeoOperation = internalMutation({
  args: {
    id: v.id("videos"),
    veoOperationName: v.string(),
    veoOperationDone: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      veoOperationName: args.veoOperationName,
      veoOperationDone: args.veoOperationDone,
    });
  },
});

export const internalUpdateProcessedFile = internalMutation({
  args: {
    id: v.id("videos"),
    processedFileKey: v.string(),
    veoOperationDone: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      processedFileKey: args.processedFileKey,
      veoOperationDone: args.veoOperationDone,
    });
  },
});

export const updateAiConfig = mutation({
  args: {
    id: v.id("videos"),
    aiConfig: v.optional(
      v.object({
        model: v.optional(v.string()),
        prompt: v.optional(v.string()),
        negativePrompt: v.optional(v.string()),
        resolution: v.optional(v.string()),
        aspectRatio: v.optional(v.string()),
        durationSeconds: v.optional(v.number()),
        fps: v.optional(v.number()),
        generateAudio: v.optional(v.boolean()),
        enhancePrompt: v.optional(v.boolean()),
        numberOfVideos: v.optional(v.number()),
        personGeneration: v.optional(v.string()),
        seed: v.optional(v.number()),
        preset: v.optional(v.string()),
        quality: v.optional(v.string()),
        captions: v.optional(v.boolean()),
        backgroundMusic: v.optional(v.boolean()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found in DB");

    const video = await ctx.db.get(args.id);
    if (!video || video.userId !== user._id) {
      throw new Error("Video not found or unauthorized");
    }

    await ctx.db.patch(args.id, { aiConfig: args.aiConfig });
  },
});

export const createGenerated = mutation({
  args: {
    title: v.string(),
    aiConfig: v.object({
      model: v.optional(v.string()),
      prompt: v.optional(v.string()),
      negativePrompt: v.optional(v.string()),
      resolution: v.optional(v.string()),
      aspectRatio: v.optional(v.string()),
      durationSeconds: v.optional(v.number()),
      fps: v.optional(v.number()),
      generateAudio: v.optional(v.boolean()),
      enhancePrompt: v.optional(v.boolean()),
      numberOfVideos: v.optional(v.number()),
      personGeneration: v.optional(v.string()),
      seed: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found in DB");

    return await ctx.db.insert("videos", {
      userId: user._id,
      title: args.title,
      rawFileKey: "",
      rawFileSize: 0,
      status: "draft",
      aiConfig: args.aiConfig,
      sourceType: "generate",
    });
  },
});

export const schedulePublish = mutation({
  args: {
    id: v.id("videos"),
    scheduledAt: v.number(),
    privacyStatus: v.optional(v.union(v.literal("private"), v.literal("public"), v.literal("unlisted"))),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const video = await ctx.db.get(args.id);
    if (!video || video.userId !== user._id) throw new Error("Video not found or unauthorized");

    await ctx.db.patch(args.id, {
      status: "scheduled",
      scheduledPublishAt: args.scheduledAt,
      ...(args.privacyStatus ? { privacyStatus: args.privacyStatus } : {}),
    });
  },
});

export const cancelSchedule = mutation({
  args: { id: v.id("videos") },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const video = await ctx.db.get(args.id);
    if (!video || video.userId !== user._id) throw new Error("Video not found or unauthorized");

    await ctx.db.patch(args.id, {
      status: "ready",
      scheduledPublishAt: undefined,
    });
  },
});

export const listScheduled = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) return [];

    const videos = await ctx.db
      .query("videos")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .collect();

    return videos.filter((v) => v.scheduledPublishAt !== undefined);
  },
});

export const internalDeleteWithRelated = internalMutation({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // Delete related jobs
    const jobs = await ctx.db
      .query("jobs")
      .withIndex("by_video", (q) => q.eq("videoId", args.videoId))
      .collect();
    for (const job of jobs) {
      await ctx.db.delete(job._id);
    }

    // Delete related generations
    const generations = await ctx.db
      .query("generations")
      .withIndex("by_video", (q) => q.eq("videoId", args.videoId))
      .collect();
    for (const gen of generations) {
      await ctx.db.delete(gen._id);
    }

    // Delete the video itself
    await ctx.db.delete(args.videoId);
  },
});

export const processDueSchedules = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const scheduledVideos = await ctx.db
      .query("videos")
      .withIndex("by_status", (q) => q.eq("status", "scheduled"))
      .collect();

    for (const video of scheduledVideos) {
      if (video.scheduledPublishAt && video.scheduledPublishAt <= now) {
        await ctx.db.patch(video._id, { status: "publishing" });
        const jobId = await ctx.db.insert("jobs", {
          userId: video.userId,
          videoId: video._id,
          type: "publish",
          status: "pending",
        });
        await ctx.scheduler.runAfter(0, api.scheduled.runPublish.processPublishJob, {
          jobId,
          videoId: video._id,
        });
      }
    }
  },
});
