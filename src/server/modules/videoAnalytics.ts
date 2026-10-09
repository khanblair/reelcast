// Port of convex/videoAnalytics.ts (queries). All aggregation runs in SQL (src/server/lib/analytics).
// Convex bug fixed: getForVideo had no ownership check; it is now owner-scoped.
// The internal upsert/oauth-status mutations live in src/server/lib/analytics/snapshots.ts.
import { z } from "zod";
import { getChannelTotals, getLatestForVideo, getTimeSeries, listLatestForUser } from "@/server/lib/analytics/queries";
import { query } from "../rpc/define";

/** Most recent snapshot of one of the caller's videos (null when none / not theirs). */
export const getForVideo = query({
  input: z.object({ videoId: z.string().uuid() }),
  handler: (ctx, args) => getLatestForVideo(ctx.db, ctx.userId, args.videoId),
});

/** Latest snapshot per video, most recently fetched first (default 50 videos). */
export const listForUser = query({
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  handler: (ctx, args) => listLatestForUser(ctx.db, ctx.userId, args.limit ?? 50),
});

/**
 * Channel-level totals over the latest snapshot of each video, plus the top 5 videos by views.
 * `avgCtr` is null (key omitted on the wire) unless some video actually has CTR data: it is
 * never fabricated, and the UI hides CTR when absent.
 */
export const getChannelSummary = query({
  handler: (ctx) => getChannelTotals(ctx.db, ctx.userId),
});

/**
 * Time series for charts. `source: "daily"` = real per-day deltas from the daily ingest;
 * `"snapshots"` = cumulative lifetime totals reconstructed from snapshots (fallback);
 * `"none"` = nothing fetched yet.
 */
export const getTimeSeriesForUser = query({
  input: z.object({ days: z.number().int().min(7).max(90).optional() }),
  handler: (ctx, args) => getTimeSeries(ctx.db, ctx.userId, args.days ?? 28),
});
