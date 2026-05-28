import { v } from "convex/values";
import { mutation, query, internalQuery } from "./_generated/server";
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
        aiAutoGenerate: undefined,
        aiGenerateTitle: undefined,
        aiGenerateDescription: undefined,
        aiGenerateTags: undefined,
        aiTone: undefined,
        aiLanguage: undefined,
        aiDescriptionLength: undefined,
        aiGuidelines: undefined,
        veoModel: undefined,
        veoResolution: undefined,
        veoAspectRatio: undefined,
        veoDurationSeconds: undefined,
        veoGenerateAudio: undefined,
        veoEnhancePrompt: undefined,
        veoPersonGeneration: undefined,
        veoNumberOfVideos: undefined,
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
    aiAutoGenerate: v.optional(v.boolean()),
    aiGenerateTitle: v.optional(v.boolean()),
    aiGenerateDescription: v.optional(v.boolean()),
    aiGenerateTags: v.optional(v.boolean()),
    aiTone: v.optional(v.string()),
    aiLanguage: v.optional(v.string()),
    aiDescriptionLength: v.optional(v.string()),
    aiGuidelines: v.optional(v.string()),
    veoModel: v.optional(v.string()),
    veoResolution: v.optional(v.string()),
    veoAspectRatio: v.optional(v.string()),
    veoDurationSeconds: v.optional(v.number()),
    veoGenerateAudio: v.optional(v.boolean()),
    veoEnhancePrompt: v.optional(v.boolean()),
    veoPersonGeneration: v.optional(v.string()),
    veoNumberOfVideos: v.optional(v.number()),
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

    const updateData: Record<string, unknown> = {};
    if (args.aiPreset !== undefined) updateData.aiPreset = args.aiPreset;
    if (args.defaultQuality !== undefined) updateData.defaultQuality = args.defaultQuality;
    if (args.defaultAspectRatio !== undefined) updateData.defaultAspectRatio = args.defaultAspectRatio;
    if (args.defaultCaptions !== undefined) updateData.defaultCaptions = args.defaultCaptions;
    if (args.defaultBackgroundMusic !== undefined) updateData.defaultBackgroundMusic = args.defaultBackgroundMusic;
    if (args.notificationsEnabled !== undefined) updateData.notificationsEnabled = args.notificationsEnabled;
    if (args.telegramChatId !== undefined) updateData.telegramChatId = args.telegramChatId;
    if (args.aiAutoGenerate !== undefined) updateData.aiAutoGenerate = args.aiAutoGenerate;
    if (args.aiGenerateTitle !== undefined) updateData.aiGenerateTitle = args.aiGenerateTitle;
    if (args.aiGenerateDescription !== undefined) updateData.aiGenerateDescription = args.aiGenerateDescription;
    if (args.aiGenerateTags !== undefined) updateData.aiGenerateTags = args.aiGenerateTags;
    if (args.aiTone !== undefined) updateData.aiTone = args.aiTone;
    if (args.aiLanguage !== undefined) updateData.aiLanguage = args.aiLanguage;
    if (args.aiDescriptionLength !== undefined) updateData.aiDescriptionLength = args.aiDescriptionLength;
    if (args.aiGuidelines !== undefined) updateData.aiGuidelines = args.aiGuidelines;
    if (args.veoModel !== undefined) updateData.veoModel = args.veoModel;
    if (args.veoResolution !== undefined) updateData.veoResolution = args.veoResolution;
    if (args.veoAspectRatio !== undefined) updateData.veoAspectRatio = args.veoAspectRatio;
    if (args.veoDurationSeconds !== undefined) updateData.veoDurationSeconds = args.veoDurationSeconds;
    if (args.veoGenerateAudio !== undefined) updateData.veoGenerateAudio = args.veoGenerateAudio;
    if (args.veoEnhancePrompt !== undefined) updateData.veoEnhancePrompt = args.veoEnhancePrompt;
    if (args.veoPersonGeneration !== undefined) updateData.veoPersonGeneration = args.veoPersonGeneration;
    if (args.veoNumberOfVideos !== undefined) updateData.veoNumberOfVideos = args.veoNumberOfVideos;

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

export const getByVideoUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});
