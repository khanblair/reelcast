/**
 * Delete a user's YouTube-derived analytics.
 *
 * YouTube API Services policy: data obtained through a user's authorization must be
 * deleted when that authorization is revoked. Called when a channel is disconnected or
 * its OAuth grant is revoked (agent B). Idempotent; only touches this user's rows.
 */
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videoAnalytics, videoDailyStats } from "@/db/schema";

export async function purgeUserAnalytics(db: DbLike, userId: string): Promise<void> {
  await db.delete(videoAnalytics).where(eq(videoAnalytics.userId, userId));
  await db.delete(videoDailyStats).where(eq(videoDailyStats.userId, userId));
}
