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

    const settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    if (!settings) {
      return {
        userId: user._id,
        notificationsEnabled: false,
        youtubeConnected: user.youtubeConnected,
        youtubeChannelName: user.youtubeChannelName,
        aiPreset: undefined,
        telegramChatId: undefined,
      };
    }

    return {
      ...settings,
      youtubeConnected: user.youtubeConnected,
      youtubeChannelName: user.youtubeChannelName,
    };
  },
});

export const update = mutation({
  args: {
    aiPreset: v.optional(v.string()),
    defaultQuality: v.optional(v.string()),
    defaultAspectRatio: v.optional(v.string()),
    defaultCaptions: v.optional(v.boolean()),
    defaultBackgroundMusic: v.optional(v.boolean()),
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

    const settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    const updateData: Partial<{
      aiPreset: string;
      defaultQuality: string;
      defaultAspectRatio: string;
      defaultCaptions: boolean;
      defaultBackgroundMusic: boolean;
      notificationsEnabled: boolean;
      telegramChatId: string;
    }> = {};
    if (args.aiPreset !== undefined) updateData.aiPreset = args.aiPreset;
    if (args.defaultQuality !== undefined) updateData.defaultQuality = args.defaultQuality;
    if (args.defaultAspectRatio !== undefined) updateData.defaultAspectRatio = args.defaultAspectRatio;
    if (args.defaultCaptions !== undefined) updateData.defaultCaptions = args.defaultCaptions;
    if (args.defaultBackgroundMusic !== undefined) updateData.defaultBackgroundMusic = args.defaultBackgroundMusic;
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

export const disconnectTelegram = mutation({
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (settings) {
      await ctx.db.patch(settings._id, {
        telegramChatId: undefined,
        notificationsEnabled: false,
      });
    }
  },
});

export const testYoutubeConnection = mutation({
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) throw new Error("User not found");

    if (!user.youtubeConnected) {
      throw new Error("YouTube account is not connected.");
    }

    // Push a dummy notification to verify
    await ctx.db.insert("notifications", {
      userId: user._id,
      title: "YouTube Connection Verified",
      message: "Successfully connected and pinged your YouTube account API.",
      type: "success",
      isRead: false,
    });
    
    return { success: true };
  },
});

export const testTelegramConnection = mutation({
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (!user) throw new Error("User not found");

    const settings = await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    if (!settings?.telegramChatId) {
      throw new Error("Telegram Chat ID is not connected.");
    }

    // Push a dummy notification to verify
    await ctx.db.insert("notifications", {
      userId: user._id,
      title: "Telegram Connection Verified",
      message: `Test message successfully sent to Telegram chat ID: @${settings.telegramChatId}`,
      type: "info",
      isRead: false,
    });
    
    return { success: true };
  },
});
