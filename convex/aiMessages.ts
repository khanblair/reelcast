import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getUserBySubject(ctx: any, subject: string) {
  return ctx.db
    .query("users")
    .withIndex("by_supabase_id", (q: any) => q.eq("supabaseId", subject))
    .unique();
}

export const append = mutation({
  args: {
    sessionId: v.id("aiSessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) throw new Error("User not found");
    return ctx.db.insert("aiMessages", {
      userId: user._id,
      sessionId: args.sessionId,
      role: args.role,
      content: args.content,
    });
  },
});

export const getContext = query({
  args: { sessionId: v.optional(v.id("aiSessions")) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) return [];

    if (args.sessionId) {
      // Messages for this session, newest-first then reversed → chronological
      const msgs = await ctx.db
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .query("aiMessages")
        .withIndex("by_session", (q: any) => q.eq("sessionId", args.sessionId))
        .order("desc")
        .take(100);
      return msgs.reverse();
    }

    return [];
  },
});
