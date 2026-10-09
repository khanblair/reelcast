/** Delete a user's video: storage files (best effort) then the rows. */
import { and, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";
import { extractCloudinaryPublicId, isAllowedMediaUrl } from "@/server/lib/cloudinary";
import { notFound } from "@/server/rpc/errors";
import { defaultDeps, type PublishDeps } from "./deps";

/**
 * Owner-scoped: someone else's video answers NOT_FOUND exactly like a missing one.
 * Cloudinary cleanup never blocks the delete (the asset may already be gone after a publish).
 * The DB delete cascades to jobs, generations, analytics and metadata versions; pending background
 * tasks that reference the video (metadata, polling) are cancelled so they don't run for a ghost.
 */
export async function deleteVideoForUser(db: DbLike, userId: string, videoId: string, deps: PublishDeps = defaultDeps()): Promise<void> {
  const [video] = await db
    .select({ id: videos.id, rawFileKey: videos.rawFileKey, processedFileKey: videos.processedFileKey })
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
    .limit(1);
  if (!video) throw notFound("Video not found");

  // Keys are client-supplied and we destroy with our own credentials: only genuine files of our cloud.
  const keys = [video.rawFileKey, video.processedFileKey].filter((k): k is string => isAllowedMediaUrl(k));
  for (const key of new Set(keys)) {
    const publicId = extractCloudinaryPublicId(key);
    if (!publicId) continue;
    try {
      await deps.destroyCloudinaryAsset(publicId, "video");
    } catch (err) {
      console.warn(`[deleteVideo] Cloudinary destroy failed for "${publicId}":`, err instanceof Error ? err.message : err);
    }
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update tasks set status = 'cancelled', updated_at = now()
       where status = 'pending' and payload->>'videoId' = ${videoId}
    `);
    await tx.delete(videos).where(and(eq(videos.id, videoId), eq(videos.userId, userId)));
  });
}
