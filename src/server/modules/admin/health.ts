// Port of convex/admin/health.ts. Admin-only. Token health exposes channel status only,
// never access/refresh tokens (explicit column projection).
import { and, eq, inArray, sql } from "drizzle-orm";
import { users, videos, youtubeChannels } from "@/db/schema";
import { query } from "../../rpc/define";

const MISSING_LIMIT = 200;
const CHANNEL_LIMIT = 1000;

/** Platform-wide Cloudinary file status of every ready/scheduled video. */
export const getStorageHealth = query({
  auth: "admin",
  handler: async (ctx) => {
    const relevant = inArray(videos.status, ["ready", "scheduled"]);
    const [agg] = await ctx.db
      .select({
        total: sql<number>`count(*)`.mapWith(Number),
        missing: sql<number>`count(*) filter (where ${videos.storageMissing} is true)`.mapWith(Number),
        healthy: sql<number>`count(*) filter (where ${videos.storageMissing} is false)`.mapWith(Number),
      })
      .from(videos)
      .where(relevant);

    const missingVideos = await ctx.db
      .select({
        videoId: videos.id,
        aiTitle: videos.aiTitle,
        title: videos.title,
        userEmail: users.email,
        status: videos.status,
        checkedAt: videos.storageCheckedAt,
      })
      .from(videos)
      .leftJoin(users, eq(users.id, videos.userId))
      .where(and(relevant, eq(videos.storageMissing, true)))
      .orderBy(sql`${videos.storageCheckedAt} desc nulls last`)
      .limit(MISSING_LIMIT);

    return {
      totalRelevant: agg.total,
      healthyCount: agg.healthy,
      missingCount: agg.missing,
      uncheckedCount: agg.total - agg.missing - agg.healthy,
      missingVideos: missingVideos.map((v) => ({
        videoId: v.videoId,
        title: v.aiTitle ?? v.title,
        userEmail: v.userEmail ?? "unknown",
        status: v.status,
        checkedAt: v.checkedAt,
      })),
    };
  },
});

/** Platform-wide YouTube token health: every connected channel (primary and secondary). */
export const getTokenHealth = query({
  auth: "admin",
  handler: async (ctx) => {
    const [countRows, channels] = await Promise.all([
      ctx.db
        .select({ status: sql<string>`coalesce(${youtubeChannels.oauthStatus}, 'unknown')`, n: sql<number>`count(*)`.mapWith(Number) })
        .from(youtubeChannels)
        .groupBy(sql`coalesce(${youtubeChannels.oauthStatus}, 'unknown')`),
      ctx.db
        .select({
          channelId: youtubeChannels.channelId,
          channelName: youtubeChannels.channelName,
          userEmail: users.email,
          isPrimary: youtubeChannels.isPrimary,
          oauthStatus: youtubeChannels.oauthStatus,
          tokenExpiry: youtubeChannels.tokenExpiry,
        })
        .from(youtubeChannels)
        .leftJoin(users, eq(users.id, youtubeChannels.userId))
        .orderBy(users.email)
        .limit(CHANNEL_LIMIT),
    ]);

    const counts: Record<string, number> = { connected: 0, token_expired: 0, revoked: 0, unknown: 0 };
    let total = 0;
    for (const r of countRows) {
      counts[r.status] = (counts[r.status] ?? 0) + r.n;
      total += r.n;
    }

    return {
      total,
      counts,
      rows: channels.map((c) => ({
        channelId: c.channelId,
        channelName: c.channelName ?? c.channelId,
        userEmail: c.userEmail ?? "unknown",
        isPrimary: c.isPrimary,
        oauthStatus: c.oauthStatus ?? "unknown",
        tokenExpiry: c.tokenExpiry,
      })),
    };
  },
});
