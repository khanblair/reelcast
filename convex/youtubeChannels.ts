import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

// List all YouTube channels connected to the current user's account
export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) return [];

    return ctx.db
      .query("youtubeChannels")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
  },
});

// Save / update a YouTube channel for the current user.
// Called from the OAuth callback instead of (or in addition to) saveYoutubeTokens.
// Enforces: each YouTube channel can only be linked to ONE Reelcast account.
export const addOrUpdate = mutation({
  args: {
    channelId: v.string(),
    channelName: v.optional(v.string()),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const tokenExpiry = Date.now() + args.expiresIn * 1000;

    // Enforce uniqueness: reject if another user already owns this channel
    const existing = await ctx.db
      .query("youtubeChannels")
      .withIndex("by_channel_id", (q) => q.eq("channelId", args.channelId))
      .unique();

    if (existing) {
      if (existing.userId !== user._id) {
        throw new Error("CHANNEL_ALREADY_CLAIMED");
      }
      // Update existing channel record
      await ctx.db.patch(existing._id, {
        channelName: args.channelName,
        accessToken: args.accessToken,
        refreshToken: args.refreshToken ?? existing.refreshToken,
        tokenExpiry,
        oauthStatus: "connected",
      });
      return existing._id;
    }

    // Check if this user has any existing channels
    const userChannels = await ctx.db
      .query("youtubeChannels")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const isPrimary = userChannels.length === 0;

    const id = await ctx.db.insert("youtubeChannels", {
      userId: user._id,
      channelId: args.channelId,
      channelName: args.channelName,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      tokenExpiry,
      oauthStatus: "connected",
      isPrimary,
    });

    // Keep users table in sync with the primary channel for backward compatibility
    if (isPrimary) {
      await ctx.db.patch(user._id, {
        youtubeConnected: true,
        youtubeChannelId: args.channelId,
        youtubeChannelName: args.channelName,
        youtubeAccessToken: args.accessToken,
        youtubeRefreshToken: args.refreshToken,
        youtubeTokenExpiry: tokenExpiry,
        youtubeOAuthStatus: "connected",
      });
    }

    return id;
  },
});

// Remove a connected YouTube channel
export const remove = mutation({
  args: { channelId: v.string() },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const channel = await ctx.db
      .query("youtubeChannels")
      .withIndex("by_channel_id", (q) => q.eq("channelId", args.channelId))
      .unique();
    if (!channel || channel.userId !== user._id) {
      throw new Error("Channel not found or not owned by this user");
    }

    const wasPrimary = channel.isPrimary ?? false;
    await ctx.db.delete(channel._id);

    // If we removed the primary, promote the next channel (if any)
    if (wasPrimary) {
      const remaining = await ctx.db
        .query("youtubeChannels")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .first();
      if (remaining) {
        await ctx.db.patch(remaining._id, { isPrimary: true });
        await ctx.db.patch(user._id, {
          youtubeConnected: true,
          youtubeChannelId: remaining.channelId,
          youtubeChannelName: remaining.channelName,
          youtubeAccessToken: remaining.accessToken,
          youtubeRefreshToken: remaining.refreshToken,
          youtubeTokenExpiry: remaining.tokenExpiry,
          youtubeOAuthStatus: remaining.oauthStatus,
        });
      } else {
        await ctx.db.patch(user._id, {
          youtubeConnected: false,
          youtubeChannelId: undefined,
          youtubeChannelName: undefined,
          youtubeAccessToken: undefined,
          youtubeRefreshToken: undefined,
          youtubeTokenExpiry: undefined,
          youtubeOAuthStatus: undefined,
        });
      }
    }
  },
});

// Set a channel as the primary (used for publishing when a video has no explicit channel)
export const setPrimary = mutation({
  args: { channelId: v.string() },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const channels = await ctx.db
      .query("youtubeChannels")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    for (const ch of channels) {
      await ctx.db.patch(ch._id, { isPrimary: ch.channelId === args.channelId });
    }

    const newPrimary = channels.find((ch) => ch.channelId === args.channelId);
    if (newPrimary) {
      await ctx.db.patch(user._id, {
        youtubeConnected: true,
        youtubeChannelId: newPrimary.channelId,
        youtubeChannelName: newPrimary.channelName,
        youtubeAccessToken: newPrimary.accessToken,
        youtubeRefreshToken: newPrimary.refreshToken,
        youtubeTokenExpiry: newPrimary.tokenExpiry,
        youtubeOAuthStatus: newPrimary.oauthStatus,
      });
    }
  },
});

// Migrate the current user's legacy single-channel data into youtubeChannels.
// Safe to call repeatedly — no-op if already migrated or no legacy data.
export const migrateFromLegacy = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) return { migrated: false };

    const existing = await ctx.db
      .query("youtubeChannels")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
    if (existing) return { migrated: false };

    if (!user.youtubeConnected || !user.youtubeChannelId || !user.youtubeAccessToken) {
      return { migrated: false };
    }

    await ctx.db.insert("youtubeChannels", {
      userId: user._id,
      channelId: user.youtubeChannelId,
      channelName: user.youtubeChannelName,
      accessToken: user.youtubeAccessToken,
      refreshToken: user.youtubeRefreshToken,
      tokenExpiry: user.youtubeTokenExpiry ?? Date.now(),
      oauthStatus: user.youtubeOAuthStatus ?? "connected",
      isPrimary: true,
    });

    return { migrated: true };
  },
});

// Internal: backfill youtubeChannels from existing users.youtubeChannelId data
export const backfill = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let created = 0;
    for (const user of users) {
      if (!user.youtubeConnected || !user.youtubeChannelId || !user.youtubeAccessToken) {
        continue;
      }
      const existing = await ctx.db
        .query("youtubeChannels")
        .withIndex("by_channel_id", (q) => q.eq("channelId", user.youtubeChannelId!))
        .unique();
      if (existing) continue;

      await ctx.db.insert("youtubeChannels", {
        userId: user._id,
        channelId: user.youtubeChannelId,
        channelName: user.youtubeChannelName,
        accessToken: user.youtubeAccessToken,
        refreshToken: user.youtubeRefreshToken,
        tokenExpiry: user.youtubeTokenExpiry ?? Date.now(),
        oauthStatus: user.youtubeOAuthStatus ?? "connected",
        isPrimary: true,
      });
      created++;
    }
    return { created };
  },
});
