"use node";

import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { isFileMissing } from "../lib/storageCheck";

type CheckTarget = { _id: string; rawFileKey: string; processedFileKey?: string };

// Checks each target's source file against Cloudinary and records the result
// (storageMissing + storageCheckedAt) via internalSetStorageHealth. Runs with
// limited concurrency to avoid hammering Cloudinary or the action runtime
// limit on a large queue.
async function checkAndRecord(
  ctx: { runMutation: (fn: never, args: never) => Promise<unknown> },
  targets: CheckTarget[]
): Promise<{ checked: number; missing: number; healthy: number }> {
  let missing = 0;
  let healthy = 0;
  const CONCURRENCY = 6;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (video) => {
        const url = video.processedFileKey ?? video.rawFileKey;
        const missingFile = await isFileMissing(url);
        await ctx.runMutation(internal.videos.internalSetStorageHealth as never, {
          id: video._id,
          storageMissing: missingFile,
        } as never);
        if (missingFile) missing++;
        else healthy++;
      })
    );
  }

  return { checked: targets.length, missing, healthy };
}

// Per-user: checks the current user's own ready + scheduled videos.
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
    return checkAndRecord(ctx, [...readyVideos, ...scheduledVideos]);
  },
});

// Admin-only: checks every user's ready + scheduled videos platform-wide.
export const checkAllUsersStorageHealth = action({
  args: {},
  handler: async (ctx): Promise<{ checked: number; missing: number; healthy: number }> => {
    const user = await ctx.runQuery(api.users.current);
    if (!user?.isAdmin) throw new Error("Admin required");

    const targets = await ctx.runQuery(internal.videos.internalGetAllPublishable);
    return checkAndRecord(ctx, targets);
  },
});
