"use node";

import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";

// HEAD request only — avoids downloading the full video body just to check
// existence. Cloudinary returns a genuine 404 with x-cld-error for a deleted
// asset, matching what a GET would report.
async function isFileMissing(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.status === 404;
  } catch {
    // Network error is inconclusive — don't flag a video as missing on a
    // transient failure, or a healthy video could get wrongly excluded from
    // auto-publish.
    return false;
  }
}

// Checks every "ready" and "scheduled" video's source file against Cloudinary
// and records the result on the video (storageMissing + storageCheckedAt).
// Runs with limited concurrency to avoid hammering Cloudinary or the action
// runtime limit on a large queue.
export const checkQueueStorageHealth = action({
  args: {},
  handler: async (ctx): Promise<{ checked: number; missing: number; healthy: number }> => {
    const user = await ctx.runQuery(api.users.current);
    if (!user) throw new Error("Unauthenticated");

    const [readyVideos, scheduledVideosRaw] = await Promise.all([
      ctx.runQuery(internal.videos.internalGetReadyForUser, {
        userId: user._id,
        limit: 1000,
      }),
      ctx.runQuery(api.videos.listScheduled, {}),
    ]);

    const scheduledVideos = scheduledVideosRaw.filter((v: { status: string }) => v.status === "scheduled");
    const targets = [...readyVideos, ...scheduledVideos];

    let missing = 0;
    let healthy = 0;
    const CONCURRENCY = 6;

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (video: { _id: string; rawFileKey: string; processedFileKey?: string }) => {
          const url = video.processedFileKey ?? video.rawFileKey;
          const missingFile = await isFileMissing(url);
          await ctx.runMutation(internal.videos.internalSetStorageHealth, {
            id: video._id as never,
            storageMissing: missingFile,
          });
          if (missingFile) missing++;
          else healthy++;
        })
      );
    }

    return { checked: targets.length, missing, healthy };
  },
});
