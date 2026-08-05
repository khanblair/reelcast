import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";

/**
 * Immediately publish a single video to YouTube on behalf of the current user.
 *
 * The heavy lifting (token refresh, resumable upload, retry logic, Cloudinary
 * cleanup, and Telegram/Discord notifications) all live inside
 * `processPublishJob` (convex/scheduled/runPublish.ts). This action only
 * orchestrates the job-creation and dispatch — it does NOT duplicate that
 * logic.
 *
 * Status transitions:
 *   ready | scheduled  →  publishing  →  (processPublishJob takes over)
 *                                          published | failed
 */
export const publishNow = action({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // 1. Resolve the current user — auth identity propagates through runQuery.
    const user = await ctx.runQuery(api.users.current, {});
    if (!user) throw new Error("Unauthenticated");

    // 2. Load the video (internal query bypasses per-user auth checks).
    const video = await ctx.runQuery(internal.videos.internalGet, {
      id: args.videoId,
    });
    if (!video) throw new Error("Video not found");
    if (video.userId !== user._id) throw new Error("Unauthorized");

    // 3. Guard: only ready/scheduled videos may be published immediately.
    if (video.status !== "ready" && video.status !== "scheduled") {
      throw new Error(
        `Cannot publish video with status "${video.status}". ` +
          `Video must be "ready" or "scheduled".`
      );
    }

    // 4. Claim the video by transitioning to "publishing" before dispatching.
    //    This prevents a double-fire if the user clicks the button twice:
    //    the second action will fail the status guard above once the first
    //    mutation has committed.
    await ctx.runMutation(internal.videos.internalUpdateStatus, {
      id: args.videoId,
      status: "publishing",
    });

    // 5. Create a pending job record.
    const jobId = await ctx.runMutation(internal.jobs.internalCreate, {
      userId: user._id,
      videoId: args.videoId,
      type: "publish",
      status: "pending",
    });

    // 6. Dispatch the publish job asynchronously.
    //    processPublishJob handles everything: token refresh, resumable upload,
    //    retries (up to 3 attempts with exponential back-off), Cloudinary
    //    cleanup, and Telegram/Discord success/failure notifications.
    await ctx.scheduler.runAfter(0, api.scheduled.runPublish.processPublishJob, {
      jobId,
      videoId: args.videoId,
    });
  },
});
