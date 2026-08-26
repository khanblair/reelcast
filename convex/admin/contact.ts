import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

/**
 * List all contact form submissions, newest first.
 * Optional status filter ("new" | "read").
 */
export const listAll = query({
  args: {
    limit: v.optional(v.number()),
    status: v.optional(v.union(v.literal("new"), v.literal("read"))),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const all = await ctx.db.query("contactSubmissions").order("desc").take(limit);
    return args.status !== undefined ? all.filter((s) => s.status === args.status) : all;
  },
});

/** Mark a submission as read. Protected at the Next.js layer. */
export const markRead = mutation({
  args: { submissionId: v.id("contactSubmissions") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.submissionId, { status: "read" });
  },
});

/** Admin hard-delete a submission. Protected at the Next.js layer. */
export const remove = mutation({
  args: { submissionId: v.id("contactSubmissions") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.submissionId);
  },
});
