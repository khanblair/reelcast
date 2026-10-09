// Port of convex/jobs.ts (user-facing functions only: list / create / retryJob).
// Executing jobs is done by the runner (src/server/jobs/*); status transitions are internal.
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/client";
import { jobs, videos } from "@/db/schema";
import { enqueueJob, requeueJob } from "@/server/jobs/queue";
import { kickRunner } from "@/server/jobs/kick";
import { LIST_LIMIT, jobColumns } from "@/server/lib/content/dto";
import { isUniqueViolation } from "@/server/lib/content/errors";
import { jobTypeSchema, uuidSchema } from "@/server/lib/content/schemas";
import { mutation, query } from "../rpc/define";
import { badRequest, conflict, notFound } from "../rpc/errors";

/**
 * A job row outlives later, separate publishes of the same video, so an old failed publish job
 * must not be re-run against a video that is already on YouTube or whose file was destroyed
 * after publishing (it would only fail with a storage 404).
 */
async function assertPublishable(db: DbLike, userId: string, videoId: string) {
  const [video] = await db
    .select({ status: videos.status, publishedVideoId: videos.publishedVideoId, cloudinaryDeletedAt: videos.cloudinaryDeletedAt })
    .from(videos)
    .where(and(eq(videos.id, videoId), eq(videos.userId, userId)))
    .limit(1);
  if (!video) throw notFound("Video not found");
  if (video.status === "published" || video.publishedVideoId) {
    throw badRequest("This video has already been published to YouTube — nothing to retry.");
  }
  if (video.cloudinaryDeletedAt) {
    throw badRequest("The video file is no longer in storage. Re-upload the video to publish it again.");
  }
}

/** The user's jobs, newest first (capped at LIST_LIMIT). */
export const list = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return [];
    return ctx.db.select(jobColumns).from(jobs).where(eq(jobs.userId, ctx.userId)).orderBy(desc(jobs.createdAt)).limit(LIST_LIMIT);
  },
});

/**
 * Queue a generation or publish job for one of the user's videos. At most one job per
 * (video, type) is active: a second call returns the already-active job's id.
 *
 * A publish job also claims the video (ready|scheduled -> publishing) in the same transaction,
 * exactly like "Publish now", so the schedule sweep and auto-publish can't pick it up again.
 */
export const create = mutation({
  input: z.object({ videoId: uuidSchema, type: jobTypeSchema }),
  handler: async (ctx, { videoId, type }) => {
    if (type === "generation") {
      const [v] = await ctx.db.select({ id: videos.id }).from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, ctx.userId))).limit(1);
      if (!v) throw notFound("Video not found");
      const { job, created } = await enqueueJob(ctx.db, { userId: ctx.userId, videoId, type });
      if (created) kickRunner();
      return job.id;
    }

    await assertPublishable(ctx.db, ctx.userId, videoId);
    const jobId = await ctx.db.transaction(async (tx) => {
      const claimed = await tx
        .update(videos)
        .set({ status: "publishing", updatedAt: new Date() })
        .where(and(eq(videos.id, videoId), eq(videos.userId, ctx.userId), inArray(videos.status, ["ready", "scheduled"])))
        .returning({ id: videos.id });
      if (!claimed[0]) {
        // Already being published (double click, or the sweep got there first): hand back that job.
        const [active] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.videoId, videoId), eq(jobs.type, "publish"), inArray(jobs.status, ["pending", "processing"])))
          .limit(1);
        if (active) return active.id;
        const [v] = await tx.select({ status: videos.status }).from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, ctx.userId))).limit(1);
        if (!v) throw notFound("Video not found");
        throw badRequest(`Cannot publish video with status "${v.status}". Video must be "ready" or "scheduled".`);
      }
      return (await enqueueJob(tx, { userId: ctx.userId, videoId, type })).job.id;
    });
    kickRunner();
    return jobId;
  },
});

/** Re-queue a failed job. Idempotent for jobs that are already pending/processing. */
export const retryJob = mutation({
  input: z.object({ id: uuidSchema }),
  handler: async (ctx, { id }) => {
    const [job] = await ctx.db
      .select({ id: jobs.id, videoId: jobs.videoId, type: jobs.type, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.userId, ctx.userId)))
      .limit(1);
    if (!job) throw notFound("Job not found");
    if (job.status === "pending" || job.status === "processing") return; // already running
    if (job.status === "completed") throw badRequest("This job already completed.");

    if (job.type === "publish") await assertPublishable(ctx.db, ctx.userId, job.videoId);

    try {
      await ctx.db.transaction(async (tx) => {
        const [active] = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.videoId, job.videoId), eq(jobs.type, job.type), inArray(jobs.status, ["pending", "processing"])))
          .limit(1);
        if (active) throw conflict("This video already has an active job of this type.");

        const requeued = await requeueJob(tx, job.id);
        if (!requeued) throw badRequest("Only failed jobs can be retried.");

        if (job.type === "publish") {
          // The job is already queued, so show the video as publishing right away. Setting it back
          // to 'scheduled' (as Convex did) let the due-schedules sweep enqueue a second publish.
          await tx
            .update(videos)
            .set({ status: "publishing", updatedAt: new Date() })
            .where(and(eq(videos.id, job.videoId), eq(videos.userId, ctx.userId), inArray(videos.status, ["failed", "scheduled", "ready"]), ne(videos.status, "published")));
        }
      });
    } catch (e) {
      // Lost a race against another job of the same (video, type) becoming active.
      if (isUniqueViolation(e)) throw conflict("This video already has an active job of this type.");
      throw e;
    }
    kickRunner();
  },
});
