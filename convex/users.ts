import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (user !== null) {
      // If we've seen this identity before but the name has changed, patch it.
      if (user.name !== identity.name) {
        await ctx.db.patch(user._id, { name: identity.name });
      }
      return user._id;
    }
    
    // If it's a new identity, create a new `User`.
    return await ctx.db.insert("users", {
      clerkId: identity.subject,
      email: identity.email!,
      name: identity.name,
      imageUrl: identity.pictureUrl,
      youtubeConnected: false,
    });
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    return await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
  },
});

export const upsertFromClerk = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    if (user !== null) {
      await ctx.db.patch(user._id, {
        name: args.name,
        imageUrl: args.imageUrl,
        email: args.email,
      });
    } else {
      await ctx.db.insert("users", {
        clerkId: args.clerkId,
        email: args.email,
        name: args.name,
        imageUrl: args.imageUrl,
        youtubeConnected: false,
      });
    }
  },
});

export const saveYoutubeTokens = mutation({
  args: {
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.number(),
    channelName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    await ctx.db.patch(user._id, {
      youtubeConnected: true,
      youtubeChannelName: args.channelName,
      youtubeAccessToken: args.accessToken,
      youtubeRefreshToken: args.refreshToken,
      youtubeTokenExpiry: Date.now() + args.expiresIn * 1000,
    });
  },
});

export const disconnectYoutube = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    await ctx.db.patch(user._id, {
      youtubeConnected: false,
      youtubeChannelName: undefined,
      youtubeAccessToken: undefined,
      youtubeRefreshToken: undefined,
      youtubeTokenExpiry: undefined,
    });
  },
});

export const getByClerkId = query({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .unique();
  },
});

export const internalGetById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

export const internalUpdateYoutubeTokens = internalMutation({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    expiresIn: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      youtubeAccessToken: args.accessToken,
      youtubeTokenExpiry: Date.now() + args.expiresIn * 1000,
    });
  },
});

export const deleteFromClerk = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    if (user !== null) {
      await ctx.db.delete(user._id);
    }
  },
});
