import { v } from "convex/values";
import { query, mutation } from "../_generated/server";

/**
 * List all users, newest first.
 * Joins the settings row for each user and includes:
 *   - autoPublishEnabled, discordWebhookUrl, telegramChatId
 *   - hasResendApiKey (boolean presence — the raw key is never returned)
 * Route-level admin protection is handled by the Next.js middleware.
 */
export const listAll = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    const users = await ctx.db.query("users").order("desc").take(limit);

    return Promise.all(
      users.map(async (user) => {
        const settings = await ctx.db
          .query("settings")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .unique();

        return {
          _id: user._id,
          _creationTime: user._creationTime,
          email: user.email,
          name: user.name,
          imageUrl: user.imageUrl,
          youtubeConnected: user.youtubeConnected,
          youtubeOAuthStatus: user.youtubeOAuthStatus,
          plan: user.plan,
          isAdmin: user.isAdmin,
          // Settings — safe subset only
          autoPublishEnabled: settings?.autoPublishEnabled ?? false,
          discordWebhookUrl: settings?.discordWebhookUrl,
          telegramChatId: settings?.telegramChatId,
          hasResendApiKey:
            settings?.resendApiKey !== undefined &&
            settings.resendApiKey !== "",
        };
      }),
    );
  },
});

/**
 * Fetch a single user with their videos and recent jobs (last 20).
 */
export const getWithDetails = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;

    const videos = await ctx.db
      .query("videos")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .collect();

    const recentJobs = await ctx.db
      .query("jobs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .take(20);

    return { user, videos, recentJobs };
  },
});

/**
 * Grant or revoke admin access.
 * No auth check — protected at the Next.js layer.
 */
export const setAdmin = mutation({
  args: {
    userId: v.id("users"),
    isAdmin: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { isAdmin: args.isAdmin });
  },
});

/**
 * Upgrade or downgrade a user's plan.
 * No auth check — protected at the Next.js layer.
 */
export const setPlan = mutation({
  args: {
    userId: v.id("users"),
    plan: v.union(v.literal("free"), v.literal("pro")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { plan: args.plan });
  },
});
