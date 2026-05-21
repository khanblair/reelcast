import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) {
      return null;
    }

    let settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    if (!settings) {
      // Default settings
      return {
        userId: user._id,
        notificationsEnabled: false,
        youtubeConnected: user.youtubeConnected,
        aiPreset: undefined,
        telegramChatId: undefined,
      };
    }

    return {
      ...settings,
      youtubeConnected: user.youtubeConnected,
    };
  },
});

export const update = mutation({
  args: {
    aiPreset: v.optional(v.string()),
    notificationsEnabled: v.optional(v.boolean()),
    telegramChatId: v.optional(v.string()),
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

    let settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    const updateData: any = {};
    if (args.aiPreset !== undefined) updateData.aiPreset = args.aiPreset;
    if (args.notificationsEnabled !== undefined) updateData.notificationsEnabled = args.notificationsEnabled;
    if (args.telegramChatId !== undefined) updateData.telegramChatId = args.telegramChatId;

    if (settings) {
      await ctx.db.patch(settings._id, updateData);
    } else {
      await ctx.db.insert("settings", {
        userId: user._id,
        notificationsEnabled: args.notificationsEnabled ?? false,
        ...updateData,
      });
    }
  },
});

export const getByUserId = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});
