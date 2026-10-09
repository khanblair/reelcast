/**
 * Everything that happens AFTER YouTube returned a video id, plus the failure bookkeeping.
 * Order matters and every step is idempotent (the job may re-run at any point):
 *   1. `published_video_id` is persisted first (done by the caller via `recordYoutubeId`);
 *   2. status -> 'published' (compare-and-swap; only the run that flips it notifies);
 *   3. Cloudinary assets are deleted best-effort;
 *   4. in-app + outbound notifications, best-effort.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";
import { extractCloudinaryPublicId, isAllowedMediaUrl } from "@/server/lib/cloudinary";
import { bestEffort, type PublishDeps } from "./deps";

export type VideoRow = typeof videos.$inferSelect;

const displayTitle = (v: Pick<VideoRow, "aiTitle" | "title">) => v.aiTitle ?? v.title;

/**
 * Persist the YouTube id (and publish time) the instant Google returns it. The `is null` guard makes
 * a second writer a no-op, so the first id ever recorded wins. Returns the id now stored.
 */
export async function recordYoutubeId(db: DbLike, videoId: string, youtubeVideoId: string): Promise<string> {
  const [row] = await db
    .update(videos)
    .set({ publishedVideoId: youtubeVideoId, publishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(videos.id, videoId), isNull(videos.publishedVideoId)))
    .returning({ publishedVideoId: videos.publishedVideoId });
  if (row?.publishedVideoId) return row.publishedVideoId;
  const [existing] = await db.select({ publishedVideoId: videos.publishedVideoId }).from(videos).where(eq(videos.id, videoId)).limit(1);
  return existing?.publishedVideoId ?? youtubeVideoId;
}

/**
 * Our Cloudinary URLs for this video (processed first, raw only when it is a different file). The keys are
 * client-supplied, and we destroy by public id with OUR credentials, so anything that is not a genuine
 * delivery URL of our own cloud is ignored (never "cleaned up").
 */
function cloudinaryUrls(video: VideoRow): string[] {
  const urls: string[] = [];
  if (isAllowedMediaUrl(video.processedFileKey)) urls.push(video.processedFileKey);
  if (isAllowedMediaUrl(video.rawFileKey) && video.rawFileKey !== video.processedFileKey) urls.push(video.rawFileKey);
  return urls;
}

/** Delete the storage files once the video is on YouTube. Best effort; flags the video only when all deletions worked. */
export async function cleanupStorage(db: DbLike, deps: PublishDeps, video: VideoRow): Promise<void> {
  if (video.cloudinaryDeletedAt) return;
  const urls = cloudinaryUrls(video);
  if (urls.length === 0) return;

  let allOk = true;
  for (const url of urls) {
    const publicId = extractCloudinaryPublicId(url);
    if (!publicId) {
      console.warn(`[publish] could not extract a Cloudinary public id from ${url}`);
      continue;
    }
    try {
      await deps.destroyCloudinaryAsset(publicId, "video");
    } catch (e) {
      allOk = false;
      console.warn(`[publish] Cloudinary cleanup failed for "${publicId}":`, e instanceof Error ? e.message : e);
    }
  }
  if (allOk) {
    await bestEffort("record cloudinary_deleted_at", () =>
      db.update(videos).set({ cloudinaryDeletedAt: new Date(), updatedAt: new Date() }).where(eq(videos.id, video.id)),
    );
  }
}

/** Finish a video whose YouTube id is already stored. Safe to call any number of times. */
export async function finalizePublished(db: DbLike, deps: PublishDeps, video: VideoRow, youtubeVideoId: string): Promise<void> {
  // Compare-and-swap: only the call that actually flips the status sends notifications.
  const flipped = await db
    .update(videos)
    .set({ status: "published", updatedAt: new Date() })
    .where(and(eq(videos.id, video.id), ne(videos.status, "published")))
    .returning({ id: videos.id });

  await cleanupStorage(db, deps, video);

  if (flipped.length === 0) return;
  const title = displayTitle(video);
  const url = `https://youtu.be/${youtubeVideoId}`;
  await bestEffort("success notification", () =>
    deps.createNotification(db, {
      userId: video.userId,
      title: "Video published",
      message: `"${title}" is now live on YouTube.`,
      type: "success",
      link: `/video/${video.id}`,
    }),
  );
  await bestEffort("success message", () => deps.sendUserNotification(db, video.userId, "publishSuccess", { title, url, youtubeVideoId }));
}

/**
 * The job is out of attempts (or hit a permanent error): mark the video failed and tell the user.
 * Never throws, and never touches a video that already has a YouTube id.
 */
export async function failVideo(
  db: DbLike,
  deps: PublishDeps,
  video: Pick<VideoRow, "id" | "userId" | "title" | "aiTitle">,
  userMessage: string,
  attemptsLabel: string,
): Promise<void> {
  let flipped = false;
  try {
    const rows = await db
      .update(videos)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(videos.id, video.id), isNull(videos.publishedVideoId), inArray(videos.status, ["publishing", "scheduled", "ready"])))
      .returning({ id: videos.id });
    flipped = rows.length > 0;
  } catch (e) {
    console.error("[publish] could not mark video failed:", e instanceof Error ? e.message : e);
  }
  if (!flipped) return;
  const title = displayTitle(video);
  await bestEffort("failure notification", () =>
    deps.createNotification(db, {
      userId: video.userId,
      title: "Publish failed",
      message: `"${title}" could not be published: ${userMessage}`,
      type: "error",
      link: `/video/${video.id}`,
    }),
  );
  await bestEffort("failure message", () =>
    deps.sendUserNotification(db, video.userId, "publishFailure", { title, error: userMessage, attemptsLabel }),
  );
}
