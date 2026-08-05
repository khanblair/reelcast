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

export const create = mutation({
  args: { title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) throw new Error("User not found");
    return ctx.db.insert("aiSessions", {
      userId: user._id,
      title: args.title,
      lastMessageAt: Date.now(),
    });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) return [];
    return ctx.db
      .query("aiSessions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(30);
  },
});

export const updateTitle = mutation({
  args: { sessionId: v.id("aiSessions"), title: v.string() },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) throw new Error("User not found");
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== user._id) throw new Error("Not found");
    await ctx.db.patch(args.sessionId, {
      title: args.title,
      lastMessageAt: Date.now(),
    });
  },
});

export const touch = mutation({
  args: { sessionId: v.id("aiSessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (session) await ctx.db.patch(args.sessionId, { lastMessageAt: Date.now() });
  },
});

export const remove = mutation({
  args: { sessionId: v.id("aiSessions") },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await getUserBySubject(ctx, identity.subject);
    if (!user) throw new Error("User not found");
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== user._id) throw new Error("Not found");
    // Delete all messages in this session
    const messages = await ctx.db
      .query("aiMessages")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .withIndex("by_session", (q: any) => q.eq("sessionId", args.sessionId))
      .collect();
    for (const msg of messages) {
      await ctx.db.delete(msg._id);
    }
    await ctx.db.delete(args.sessionId);
  },
});
