import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCurrentUserRecord(ctx: Parameters<typeof getCurrentUserOrThrow>[0]) {
  const identity = await getCurrentUserOrThrow(ctx);
  return (ctx as any).db
    .query("users")
    .withIndex("by_supabase_id", (q: any) => q.eq("supabaseId", identity.subject))
    .unique() as Promise<any | null>;
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Returns the most recent analytics snapshot for the given video.
 */
export const getForVideo = query({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("videoAnalytics")
      .withIndex("by_video", (q) => q.eq("videoId", args.videoId))
      .collect();
    if (rows.length === 0) return null;
    return rows.reduce((best, r) => (r.fetchedAt > best.fetchedAt ? r : best));
  },
});

/**
 * Returns the latest analytics snapshot per published video for the current
 * user. Deduplicates by videoId, keeping the row with the highest fetchedAt,
 * then applies limit (default 50 distinct videos).
 */
export const listForUser = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const user = await getCurrentUserRecord(ctx);
    if (!user) return [];
    const cap = args.limit ?? 50;

    // Walk all rows for this user, newest first (by_user_fetched orders by
    // fetchedAt when userId is constrained).
    const all = await ctx.db
      .query("videoAnalytics")
      .withIndex("by_user_fetched", (q) => q.eq("userId", user._id))
      .order("desc")
      .collect();

    // Deduplicate: first occurrence per videoId is the most recent.
    const seen = new Map<string, (typeof all)[number]>();
    for (const row of all) {
      if (!seen.has(row.videoId)) seen.set(row.videoId, row);
      if (seen.size >= cap) break;
    }
    return Array.from(seen.values());
  },
});

/**
 * Returns aggregate channel-level analytics across all published videos for
 * the current user, plus the top-5 videos by view count.
 */
export const getChannelSummary = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserRecord(ctx);
    if (!user) return null;

    // Collect every analytics row for this user, newest first.
    const all = await ctx.db
      .query("videoAnalytics")
      .withIndex("by_user_fetched", (q) => q.eq("userId", user._id))
      .order("desc")
      .collect();

    // One snapshot per video (the most recent).
    const latestByVideo = new Map<string, (typeof all)[number]>();
    for (const row of all) {
      if (!latestByVideo.has(row.videoId)) latestByVideo.set(row.videoId, row);
    }
    const rows = Array.from(latestByVideo.values());

    let totalViews = 0;
    let totalWatchTimeMinutes = 0;
    let totalImpressions = 0;
    let ctrSum = 0;
    let ctrCount = 0;

    for (const r of rows) {
      totalViews += r.views ?? 0;
      totalWatchTimeMinutes += r.watchTimeMinutes ?? 0;
      totalImpressions += r.impressions ?? 0;
      if (r.ctr !== undefined) {
        ctrSum += r.ctr;
        ctrCount++;
      }
    }

    // Guard divide-by-zero: only compute avgCtr when there are rows with CTR data.
    const avgCtr = ctrCount > 0 ? ctrSum / ctrCount : null;

    const topVideos = [...rows]
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 5)
      .map((r) => ({
        videoId: r.videoId,
        youtubeVideoId: r.youtubeVideoId,
        views: r.views,
        watchTimeMinutes: r.watchTimeMinutes,
        ctr: r.ctr,
      }));

    return { totalViews, totalWatchTimeMinutes, totalImpressions, avgCtr, topVideos };
  },
});

// ── Internal mutations ────────────────────────────────────────────────────────

/**
 * Upserts an analytics snapshot for a video.
 *
 * If a row already exists for the same (videoId, UTC calendar day of
 * fetchedAt): the existing row is patched with the new values.
 * Otherwise: a new row is inserted.
 */
export const upsertAnalytics = internalMutation({
  args: {
    userId: v.id("users"),
    videoId: v.id("videos"),
    youtubeVideoId: v.string(),
    fetchedAt: v.number(),
    views: v.optional(v.number()),
    watchTimeMinutes: v.optional(v.number()),
    avgViewDurationSec: v.optional(v.number()),
    impressions: v.optional(v.number()),
    ctr: v.optional(v.number()),
    likes: v.optional(v.number()),
    comments: v.optional(v.number()),
    subscribersGained: v.optional(v.number()),
    estimatedRevenue: v.optional(v.number()),
    rpm: v.optional(v.number()),
    cpm: v.optional(v.number()),
    trafficSourceSearch: v.optional(v.number()),
    trafficSourceSuggested: v.optional(v.number()),
    trafficSourceExternal: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Determine the UTC day window for the incoming fetchedAt.
    const dayStart = new Date(args.fetchedAt);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = dayStart.getTime() + 86_400_000;

    const existing = await ctx.db
      .query("videoAnalytics")
      .withIndex("by_video", (q) => q.eq("videoId", args.videoId))
      .filter((q) =>
        q.and(
          q.gte(q.field("fetchedAt"), dayStart.getTime()),
          q.lt(q.field("fetchedAt"), dayEnd),
        )
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("videoAnalytics", args);
    }
  },
});

/**
 * Marks the user's YouTube OAuth status (e.g. token_expired after a 401).
 */
export const internalSetYoutubeOAuthStatus = internalMutation({
  args: {
    userId: v.id("users"),
    status: v.union(
      v.literal("connected"),
      v.literal("token_expired"),
      v.literal("revoked"),
      v.literal("unknown"),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { youtubeOAuthStatus: args.status });
  },
});
