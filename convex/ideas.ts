import { v } from "convex/values";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

async function resolveUser(ctx: MutationCtx) {
  const identity = await getCurrentUserOrThrow(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
    .unique();
  if (!user) throw new Error("User not found in DB");
  return user;
}

// Returns all ideas for the current user, optionally filtered by status, newest first.
export const list = query({
  args: {
    status: v.optional(
      v.union(v.literal("concept"), v.literal("in_production"), v.literal("published"))
    ),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) return [];

    const ideas = await ctx.db
      .query("ideas")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .collect();

    if (args.status !== undefined) {
      return ideas.filter((idea) => idea.status === args.status);
    }
    return ideas;
  },
});

// Creates a new idea with status "concept".
export const create = mutation({
  args: {
    title: v.string(),
    notes: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    scheduledGenerateAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await resolveUser(ctx);
    return await ctx.db.insert("ideas", {
      userId: user._id,
      title: args.title,
      notes: args.notes,
      tags: args.tags,
      status: "concept",
      scheduledGenerateAt: args.scheduledGenerateAt,
    });
  },
});

// Updates an existing idea — verifies ownership before patching.
export const update = mutation({
  args: {
    ideaId: v.id("ideas"),
    title: v.optional(v.string()),
    notes: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    status: v.optional(
      v.union(v.literal("concept"), v.literal("in_production"), v.literal("published"))
    ),
    scheduledGenerateAt: v.optional(v.number()),
    linkedVideoId: v.optional(v.id("videos")),
  },
  handler: async (ctx, args) => {
    const user = await resolveUser(ctx);
    const idea = await ctx.db.get(args.ideaId);
    if (!idea) throw new Error("Idea not found");
    if (idea.userId !== user._id) throw new Error("Not authorized");

    const patchData: Record<string, unknown> = {};
    if (args.title !== undefined) patchData.title = args.title;
    if (args.notes !== undefined) patchData.notes = args.notes;
    if (args.tags !== undefined) patchData.tags = args.tags;
    if (args.status !== undefined) patchData.status = args.status;
    if (args.scheduledGenerateAt !== undefined) patchData.scheduledGenerateAt = args.scheduledGenerateAt;
    if (args.linkedVideoId !== undefined) patchData.linkedVideoId = args.linkedVideoId;

    await ctx.db.patch(args.ideaId, patchData);
  },
});

// Deletes an idea — verifies ownership first.
export const remove = mutation({
  args: { ideaId: v.id("ideas") },
  handler: async (ctx, args) => {
    const user = await resolveUser(ctx);
    const idea = await ctx.db.get(args.ideaId);
    if (!idea) throw new Error("Idea not found");
    if (idea.userId !== user._id) throw new Error("Not authorized");
    await ctx.db.delete(args.ideaId);
  },
});

// Links an idea to a video and moves it to "in_production".
export const linkVideo = mutation({
  args: {
    ideaId: v.id("ideas"),
    videoId: v.id("videos"),
  },
  handler: async (ctx, args) => {
    const user = await resolveUser(ctx);
    const idea = await ctx.db.get(args.ideaId);
    if (!idea) throw new Error("Idea not found");
    if (idea.userId !== user._id) throw new Error("Not authorized");
    await ctx.db.patch(args.ideaId, {
      linkedVideoId: args.videoId,
      status: "in_production",
    });
  },
});
