import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

// ─── list ─────────────────────────────────────────────────────────────────────

/**
 * Returns all "ready" and "scheduled" videos for the current user, sorted by:
 *   1. publishOrder asc (nulls last)
 *   2. _creationTime asc (tie-break)
 *
 * Each item carries: _id, title, thumbnailUrl, status, scheduledPublishAt,
 * publishOrder, duration, privacyStatus, publishAs, rawFileSize,
 * estimatedPublishAt (always null — callers compute from position + schedule).
 */
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

    const [readyVideos, scheduledVideos] = await Promise.all([
      ctx.db
        .query("videos")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", "ready")
        )
        .collect(),
      ctx.db
        .query("videos")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", "scheduled")
        )
        .collect(),
    ]);

    const videos = [...readyVideos, ...scheduledVideos];

    // Sort: publishOrder asc (nulls last), then _creationTime asc
    videos.sort((a, b) => {
      const aOrder = a.publishOrder ?? null;
      const bOrder = b.publishOrder ?? null;

      if (aOrder === null && bOrder === null) {
        return a._creationTime - b._creationTime;
      }
      if (aOrder === null) return 1;  // a → after b
      if (bOrder === null) return -1; // a → before b
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a._creationTime - b._creationTime;
    });

    return videos.map((video) => ({
      _id: video._id,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      status: video.status,
      scheduledPublishAt: video.scheduledPublishAt,
      publishOrder: video.publishOrder,
      duration: video.duration,
      privacyStatus: video.privacyStatus,
      publishAs: video.publishAs,
      rawFileSize: video.rawFileSize,
      storageMissing: video.storageMissing ?? false,
      storageCheckedAt: video.storageCheckedAt,
      estimatedPublishAt: null as null,
    }));
  },
});

// ─── setPublishOrder ──────────────────────────────────────────────────────────

export const setPublishOrder = mutation({
  args: {
    videoId: v.id("videos"),
    publishOrder: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found in DB");

    const video = await ctx.db.get(args.videoId);
    if (!video || video.userId !== user._id) {
      throw new Error("Video not found or unauthorized");
    }

    await ctx.db.patch(args.videoId, { publishOrder: args.publishOrder });
  },
});

// ─── bulkSetPublishOrder ──────────────────────────────────────────────────────

export const bulkSetPublishOrder = mutation({
  args: {
    orders: v.array(
      v.object({ videoId: v.id("videos"), publishOrder: v.number() })
    ),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found in DB");

    for (const { videoId, publishOrder } of args.orders) {
      const video = await ctx.db.get(videoId);
      if (!video || video.userId !== user._id) {
        throw new Error("Video not found or unauthorized");
      }
      await ctx.db.patch(videoId, { publishOrder });
    }
  },
});

// ─── getQueueStats ────────────────────────────────────────────────────────────

/**
 * Returns aggregate counts for the queue plus the next scheduled auto-publish
 * timestamp (from settings.autoPublishNextAt).
 */
export const getQueueStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { readyCount: 0, scheduledCount: 0, nextPublishAt: null };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
      .unique();
    if (!user) {
      return { readyCount: 0, scheduledCount: 0, nextPublishAt: null };
    }

    const [readyVideos, scheduledVideos, settings] = await Promise.all([
      ctx.db
        .query("videos")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", "ready")
        )
        .collect(),
      ctx.db
        .query("videos")
        .withIndex("by_user_status", (q) =>
          q.eq("userId", user._id).eq("status", "scheduled")
        )
        .collect(),
      ctx.db
        .query("settings")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .unique(),
    ]);

    return {
      readyCount: readyVideos.length,
      scheduledCount: scheduledVideos.length,
      nextPublishAt: settings?.autoPublishNextAt ?? null,
    };
  },
});
