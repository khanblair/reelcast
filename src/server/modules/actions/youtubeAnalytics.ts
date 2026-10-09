// Port of convex/actions/youtubeAnalytics.ts. Owner-scoped, bounded (<= 50 videos per refresh,
// 5 requests in flight, ~40s budget). The long-running work is the 6-hourly daily ingest
// (src/server/jobs/handlers/analytics.ts), not these on-demand refreshes.
//
// `fetchChannelStats` (28-day channel totals) was never called by the UI and is not ported.
import { z } from "zod";
import { loadYoutubeDeps } from "@/server/lib/analytics/deps";
import { fetchSnapshotsForUser } from "@/server/lib/analytics/snapshots";
import { badRequest } from "../../rpc/errors";
import { action } from "../../rpc/define";

/**
 * Refresh YouTube analytics for one of the caller's published videos.
 * Returns the stored snapshot values, or null when YouTube reports no data yet.
 */
export const fetchForVideo = action({
  input: z.object({ videoId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const deps = await loadYoutubeDeps(ctx.db);
    const run = await fetchSnapshotsForUser({ db: ctx.db, ...deps }, ctx.userId, { videoId: args.videoId });
    const r = run.results[0];
    if (r && !r.ok) throw badRequest(r.error ?? "Failed to fetch analytics");
    return r?.data ?? null;
  },
});

/**
 * Refresh analytics for the caller's published videos (most recent 50). Per-video results are
 * returned; `truncated`/`total` tell the UI when more videos remain than were refreshed.
 */
export const fetchForUser = action({
  handler: async (ctx) => {
    const deps = await loadYoutubeDeps(ctx.db);
    return fetchSnapshotsForUser({ db: ctx.db, ...deps }, ctx.userId);
  },
});
