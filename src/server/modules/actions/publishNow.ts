// Port of convex/actions/publishNow.ts. Export ONLY rpc definitions from this file.
import { z } from "zod";
import { kickRunner } from "@/server/jobs/kick";
import { claimAndEnqueuePublish } from "@/server/lib/publish/claim";
import { action } from "../../rpc/define";
import { badRequest, notFound } from "../../rpc/errors";

/**
 * Publish one of the caller's videos now. Like the Convex action this returns as soon as the work
 * is QUEUED (the upload happens in the background job; the UI sees the status change by polling).
 *
 * ready | scheduled -> publishing is a compare-and-swap done in the same transaction as the job
 * insert, so a double click (or a click racing the schedule sweep) queues exactly one publish and
 * the loser gets the same "Cannot publish video with status ..." answer as before.
 */
export const publishNow = action({
  input: z.object({ videoId: z.string().uuid() }),
  handler: async (ctx, { videoId }) => {
    const r = await claimAndEnqueuePublish(ctx.db, { userId: ctx.userId, videoId, fromStates: ["ready", "scheduled"] });
    if (!r.ok) {
      if (r.reason === "not_found") throw notFound("Video not found");
      throw badRequest(`Cannot publish video with status "${r.status}". Video must be "ready" or "scheduled".`);
    }
    kickRunner();
  },
});
