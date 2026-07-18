"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";

export const runAutoPublishBatch = action({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const settings = await ctx.runQuery(internal.settings.getByVideoUserId, {
      userId: args.userId,
    });

    if (!settings?.autoPublishEnabled) return;

    const intervalMs = settings.autoPublishIntervalMs ?? 6 * 60 * 60 * 1000;
    const count = settings.autoPublishCount ?? 1;
    const privacy = (settings.autoPublishPrivacy ?? "public") as "private" | "public" | "unlisted";

    const readyVideos = await ctx.runQuery(internal.videos.internalGetReadyForUser, {
      userId: args.userId,
      limit: count,
    });

    for (const video of readyVideos) {
      let claimed = false;
      try {
        claimed = await ctx.runMutation(internal.videos.internalClaimForPublishing, {
          id: video._id,
          privacyStatus: privacy,
        });
        if (!claimed) continue; // already taken by schedulePublish or another concurrent run
        const jobId = await ctx.runMutation(internal.jobs.internalCreate, {
          userId: args.userId,
          videoId: video._id,
          type: "publish",
          status: "pending",
        });
        await ctx.scheduler.runAfter(0, api.scheduled.runPublish.processPublishJob, {
          jobId,
          videoId: video._id,
        });
      } catch (err) {
        console.error(`[autoPublish] Failed to queue video ${video._id}:`, err);
        if (claimed) {
          try {
            await ctx.runMutation(internal.videos.internalUpdateStatus, {
              id: video._id,
              status: "ready",
            });
          } catch (rollbackErr) {
            console.error(`[autoPublish] Rollback failed for ${video._id}:`, rollbackErr);
          }
        }
      }
    }

    const nextAt = Date.now() + intervalMs;
    const schedulerId = await ctx.scheduler.runAt(
      nextAt,
      api.actions.autoPublish.runAutoPublishBatch,
      { userId: args.userId }
    );

    await ctx.runMutation(internal.settings.internalUpdateAutoPublishNext, {
      userId: args.userId,
      schedulerId,
      nextAt,
    });
  },
});
