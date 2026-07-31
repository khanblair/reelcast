import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

export const internalCreate = internalMutation({
  args: {
    userId: v.id("users"),
    videoId: v.id("videos"),
    model: v.string(),
    prompt: v.string(),
    negativePrompt: v.optional(v.string()),
    resolution: v.string(),
    aspectRatio: v.string(),
    durationSeconds: v.number(),
    generateAudio: v.boolean(),
    veoOperationName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("generations", {
      userId: args.userId,
      videoId: args.videoId,
      model: args.model,
      prompt: args.prompt,
      negativePrompt: args.negativePrompt,
      resolution: args.resolution,
      aspectRatio: args.aspectRatio,
      durationSeconds: args.durationSeconds,
      generateAudio: args.generateAudio,
      status: "submitted",
      veoOperationName: args.veoOperationName,
    });
  },
});

export const internalUpdateStatus = internalMutation({
  args: {
    videoId: v.id("videos"),
    status: v.union(
      v.literal("submitted"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed")
    ),
    outputVideoUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    generationTimeMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const generation = await ctx.db
      .query("generations")
      .withIndex("by_video", (q) => q.eq("videoId", args.videoId))
      .order("desc")
      .first();

    if (!generation) return;

    const updates: Record<string, unknown> = { status: args.status };
    if (args.outputVideoUrl) updates.outputVideoUrl = args.outputVideoUrl;
    if (args.error) updates.error = args.error;
    if (args.generationTimeMs) updates.generationTimeMs = args.generationTimeMs;

    await ctx.db.patch(generation._id, updates);
  },
});

export const listByUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) return [];

    return await ctx.db
      .query("generations")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .collect();
  },
});
