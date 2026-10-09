/**
 * AI-metadata history, read side. Convex kept `videos.metadataHistory` as an unbounded array; here
 * every overwrite of the AI metadata snapshots the previous values into `video_metadata_versions`
 * (written and trimmed to 10 by `saveVideoMetadata` in src/server/lib/ai/metadata.ts).
 */
import { desc, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videoMetadataVersions } from "@/db/schema";

export const METADATA_HISTORY_LIMIT = 10;

/** Task `dedupeKey` for the scheduled `metadata.generate` task of a video. */
export const metadataTaskKey = (videoId: string) => `metadata:${videoId}`;

/** Newest-first history (last 10) in the shape the UI renders. */
export async function listMetadataHistory(db: DbLike, videoId: string) {
  return db
    .select({
      savedAt: videoMetadataVersions.savedAt,
      aiTitle: videoMetadataVersions.aiTitle,
      aiDescription: videoMetadataVersions.aiDescription,
      aiTags: videoMetadataVersions.aiTags,
    })
    .from(videoMetadataVersions)
    .where(eq(videoMetadataVersions.videoId, videoId))
    .orderBy(desc(videoMetadataVersions.savedAt), desc(videoMetadataVersions.id))
    .limit(METADATA_HISTORY_LIMIT);
}
