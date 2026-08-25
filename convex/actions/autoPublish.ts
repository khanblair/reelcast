"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";

// Compute the next timezone-aligned time slot after nowMs (always at least 60s in future).
// timeSlots is an array of local hours (0–23). timezoneOffsetHours defaults to EAT (+3).
function nextSlotMs(timeSlots: number[], nowMs: number, timezoneOffsetHours = 3): number {
  const TZ_OFFSET_MS = timezoneOffsetHours * 60 * 60 * 1000;
  const eatMs = nowMs + TZ_OFFSET_MS;
  const eatDate = new Date(eatMs);
  const msSinceEatMidnight =
    eatDate.getUTCHours() * 3_600_000 +
    eatDate.getUTCMinutes() * 60_000 +
    eatDate.getUTCSeconds() * 1_000 +
    eatDate.getUTCMilliseconds();
  const eatMidnightMs = nowMs - msSinceEatMidnight;
  const sorted = [...timeSlots].sort((a, b) => a - b);
  const minFutureMs = nowMs + 60_000;
  for (const h of sorted) {
    const slotMs = eatMidnightMs + h * 3_600_000;
    if (slotMs >= minFutureMs) return slotMs;
  }
  return eatMidnightMs + 24 * 3_600_000 + sorted[0] * 3_600_000;
}

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

    // Overfetch and skip videos already flagged storageMissing (from the storage
    // health check) — otherwise a run capped at exactly `count` could pull only
    // known-dead videos and publish nothing, even with healthy videos waiting
    // further back in the FIFO queue.
    const candidates = await ctx.runQuery(internal.videos.internalGetReadyForUser, {
      userId: args.userId,
      limit: Math.max(count * 5, 25),
    });
    const readyVideos = candidates
      .filter((v) => v.storageMissing !== true)
      .slice(0, count);

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

    const timeSlots = (settings as any).autoPublishTimeSlots as number[] | undefined;
    const tzOffset = (settings as any).autoPublishTimezoneOffset as number | undefined;
    const nextAt = timeSlots?.length
      ? nextSlotMs(timeSlots, Date.now(), tzOffset ?? 3)
      : Date.now() + intervalMs;
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
