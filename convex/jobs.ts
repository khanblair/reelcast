import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { api } from "./_generated/api";
import { getCurrentUserOrThrow } from "./lib/auth";

export const create = mutation({
  args: {
    videoId: v.id("videos"),
    type: v.union(v.literal("generation"), v.literal("publish")),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found in DB");
    }

    const video = await ctx.db.get(args.videoId);
    if (!video || video.userId !== user._id) {
      throw new Error("Video not found or unauthorized");
    }

    const jobId = await ctx.db.insert("jobs", {
      userId: user._id,
      videoId: args.videoId,
      type: args.type,
      status: "pending",
    });

    if (args.type === "generation") {
      // Route to the correct generation pipeline based on video source type
      if (video.sourceType === "generate") {
        await ctx.scheduler.runAfter(0, api.actions.generation.startVeoGeneration, {
          jobId,
          videoId: args.videoId,
        });
      } else {
        // Uploaded video: run Gemini metadata analysis
        await ctx.scheduler.runAfter(0, api.scheduled.runGeneration.processGenerationJob, {
          jobId,
          videoId: args.videoId,
        });
      }
    } else if (args.type === "publish") {
      // Schedule the publish action
      await ctx.scheduler.runAfter(0, api.scheduled.runPublish.processPublishJob, {
        jobId,
        videoId: args.videoId,
      });
    }

    return jobId;
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
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();

    if (!user) {
      return [];
    }

    return await ctx.db
      .query("jobs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .collect();
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("jobs"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed")
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found in DB");
    }

    const job = await ctx.db.get(args.id);
    if (!job || job.userId !== user._id) {
      throw new Error("Job not found or unauthorized");
    }

    const updates: Record<string, unknown> = { status: args.status };
    if (args.error !== undefined) {
      updates.error = args.error;
    }
    if (args.status === "processing" && job.status === "pending") {
      updates.startedAt = Date.now();
    }
    if (args.status === "completed" || args.status === "failed") {
      updates.completedAt = Date.now();
    }

    await ctx.db.patch(args.id, updates);
  },
});

export const internalCreate = internalMutation({
  args: {
    userId: v.id("users"),
    videoId: v.id("videos"),
    type: v.union(v.literal("generation"), v.literal("publish")),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("jobs", {
      userId: args.userId,
      videoId: args.videoId,
      type: args.type,
      status: args.status,
    });
  },
});

// Internal mutation — used by scheduled actions (no auth check, trusted context)
export const internalUpdateStatus = internalMutation({
  args: {
    id: v.id("jobs"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed")
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.id);
    if (!job) throw new Error("Job not found");

    const updates: Record<string, unknown> = { status: args.status };
    if (args.error !== undefined) {
      updates.error = args.error;
    }
    if (args.status === "processing" && job.status === "pending") {
      updates.startedAt = Date.now();
    }
    if (args.status === "completed" || args.status === "failed") {
      updates.completedAt = Date.now();
    }

    await ctx.db.patch(args.id, updates);
  },
});

export const retryJob = mutation({
  args: {
    id: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();

    if (!user) {
      throw new Error("User not found in DB");
    }

    const job = await ctx.db.get(args.id);
    if (!job || job.userId !== user._id) {
      throw new Error("Job not found or unauthorized");
    }

    if (job.type === "publish") {
      // Guard: a job row is never removed once a video moves on, so an old
      // failed publish job can outlive a later, separate successful publish
      // of the same video. Retrying it would force an already-published
      // video back to "scheduled" and re-upload against files that were
      // already destroyed post-publish — always failing with a storage 404.
      const video = await ctx.db.get(job.videoId);
      if (video?.status === "published" || video?.publishedVideoId) {
        throw new Error("This video has already been published to YouTube — nothing to retry.");
      }
      if ((video as any)?.cloudinaryDeletedAt) {
        throw new Error("The video file is no longer in storage. Re-upload the video to publish it again.");
      }
    }

    await ctx.db.patch(args.id, {
      status: "pending",
      error: undefined,
      startedAt: undefined,
      completedAt: undefined,
    });

    if (job.type === "generation") {
      const video = await ctx.db.get(job.videoId);
      if (video?.sourceType === "generate") {
        await ctx.scheduler.runAfter(0, api.actions.generation.startVeoGeneration, {
          jobId: args.id,
          videoId: job.videoId,
        });
      } else {
        await ctx.scheduler.runAfter(0, api.scheduled.runGeneration.processGenerationJob, {
          jobId: args.id,
          videoId: job.videoId,
        });
      }
    } else if (job.type === "publish") {
      // Reset video status back to scheduled so it doesn't stay stuck at "failed"
      await ctx.db.patch(job.videoId, { status: "scheduled" });
      await ctx.scheduler.runAfter(0, api.scheduled.runPublish.processPublishJob, {
        jobId: args.id,
        videoId: job.videoId,
      });
    }
  },
});
