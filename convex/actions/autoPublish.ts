"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { isFileMissing } from "../lib/storageCheck";

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

    // Overfetch candidates — a run capped at exactly `count` could otherwise pull
    // only known-dead videos and publish nothing, even with healthy videos
    // waiting further back in the FIFO queue.
    const candidates = await ctx.runQuery(internal.videos.internalGetReadyForUser, {
      userId: args.userId,
      limit: Math.max(count * 5, 25),
    });

    // Freshly verify each candidate's file right before selecting — don't just
    // trust a stale storageMissing flag from a prior manual check. This is what
    // catches a video that died *since* the last check, not only ones someone
    // already found. Skip the network call for videos already confirmed dead.
    const checked = await Promise.all(
      candidates.map(async (video) => {
        const wasMissing = video.storageMissing === true;
        const missing = wasMissing || (await isFileMissing(video.processedFileKey ?? video.rawFileKey));
        if (missing !== wasMissing) {
          await ctx.runMutation(internal.videos.internalSetStorageHealth, {
            id: video._id,
            storageMissing: missing,
          });
        }
        return { video, missing, newlyDetected: missing && !wasMissing };
      })
    );

    const newlyDead = checked.filter((c) => c.newlyDetected);
    const readyVideos = checked
      .filter((c) => !c.missing)
      .map((c) => c.video)
      .slice(0, count);

    // Tell the user — otherwise a skip is silent and they only find out when
    // the video never shows up as published. Fires once per video, right when
    // it's first detected dead, not on every subsequent run.
    if (newlyDead.length > 0) {
      const list = newlyDead
        .map((c) => `• ${c.video.aiTitle ?? c.video.title}`)
        .join("\n");
      await ctx.runAction(api.actions.telegram.sendNotification, {
        userId: args.userId,
        message:
          `⚠️ Auto-publish found ${newlyDead.length} video(s) with a missing storage file and skipped ${newlyDead.length === 1 ? "it" : "them"}:\n${list}\n\n` +
          `Re-upload to publish. Other queued videos will now publish sooner since they no longer wait behind ${newlyDead.length === 1 ? "this one" : "these"}.`,
      }).catch(() => {});
    }

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
