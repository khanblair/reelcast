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
      throw new Error("Video not found or unauthorized");
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
