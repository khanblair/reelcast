import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

async function getUserBySubject(ctx: any, subject: string) {
  return ctx.db
    .query("users")
    .withIndex("by_supabase_id", (q: any) => q.eq("supabaseId", subject))
    .unique();
}

export const append = mutation({
  args: {
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) throw new Error("User not found");
    return ctx.db.insert("aiMessages", {
      userId: user._id,
      role: args.role,
      content: args.content,
    });
  },
});

export const getContext = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) return [];
    // Fetch last 20 messages descending, then reverse to chronological order
    const messages = await ctx.db
      .query("aiMessages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
    return messages.reverse();
  },
});
