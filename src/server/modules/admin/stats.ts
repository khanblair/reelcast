// Port of convex/admin/stats.ts getStats. All counts/sums run in SQL (no table scans in JS).
// `getSystemStats` was internal and unused in Convex, so it is not ported.
import { and, count, eq, gte, isNotNull, sql } from "drizzle-orm";
import { jobs, settings, users, videos, youtubeChannels } from "@/db/schema";
import { query } from "../../rpc/define";

export const getStats = query({
  auth: "admin",
  handler: async (ctx) => {
    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    const last24h = new Date(Date.now() - 86_400_000);

    const [userAgg, channelAgg, videoAgg, jobAgg, publishAgg, settingsAgg] = await Promise.all([
      ctx.db.select({ total: count(), admins: sql<number>`count(*) filter (where ${users.isAdmin})`.mapWith(Number) }).from(users),
      ctx.db.select({ connected: count() }).from(youtubeChannels).where(eq(youtubeChannels.isPrimary, true)),
      ctx.db
        .select({
          total: count(),
          published: sql<number>`count(*) filter (where ${videos.status} = 'published')`.mapWith(Number),
          bytes: sql<number>`coalesce(sum(${videos.rawFileSize}), 0)`.mapWith(Number),
        })
        .from(videos),
      ctx.db.select({ today: count() }).from(jobs).where(gte(jobs.startedAt, startOfTodayUtc)),
      // Publish jobs that finished (completed or failed) in the last 24h.
      ctx.db
        .select({
          total: count(),
          ok: sql<number>`count(*) filter (where ${jobs.status} = 'completed')`.mapWith(Number),
        })
        .from(jobs)
        .where(and(eq(jobs.type, "publish"), isNotNull(jobs.completedAt), gte(jobs.completedAt, last24h))),
      ctx.db.select({ active: count() }).from(settings).where(eq(settings.autoPublishEnabled, true)),
    ]);

    const finished = publishAgg[0].total;
    return {
      totalUsers: userAgg[0].total,
      youtubeConnected: channelAgg[0].connected,
      adminCount: userAgg[0].admins,
      totalVideos: videoAgg[0].total,
      publishedVideos: videoAgg[0].published,
      totalStorageBytes: videoAgg[0].bytes,
      jobsToday: jobAgg[0].today,
      successRate24h: finished > 0 ? publishAgg[0].ok / finished : null,
      autoPublishActive: settingsAgg[0].active,
    };
  },
});
