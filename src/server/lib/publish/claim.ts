/**
 * Moving a video into "publishing" and creating its publish job: ONE transaction, so a crash can
 * never strand a "publishing" video without a job (or leave a job for a video someone else claimed).
 *
 * The state change is a compare-and-swap (`UPDATE ... WHERE status IN (<from>) RETURNING`): when many
 * callers race for the same video (double click, sweep + publish-now, two auto-publish runs) exactly
 * one gets the row. Postgres READ COMMITTED re-checks the WHERE after waiting on the row lock, so the
 * losers see 0 rows.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";
import { enqueueJob } from "@/server/jobs/queue";

type VideoStatus = (typeof videos.$inferSelect)["status"];
type Privacy = NonNullable<(typeof videos.$inferSelect)["privacyStatus"]>;

export type ClaimResult =
  | { ok: true; jobId: string; jobCreated: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "bad_state"; status: VideoStatus };

export type ClaimInput = {
  userId: string;
  videoId: string;
  /** The states the caller may publish from (publish-now: ready|scheduled, auto-publish: ready). */
  fromStates: readonly VideoStatus[];
  /** Auto-publish stamps the user's chosen privacy on the video as it claims it. */
  privacyStatus?: Privacy;
  runAt?: Date;
};

export async function claimAndEnqueuePublish(db: DbLike, input: ClaimInput): Promise<ClaimResult> {
  return db.transaction(async (tx): Promise<ClaimResult> => {
    const [claimed] = await tx
      .update(videos)
      .set({
        status: "publishing",
        updatedAt: new Date(),
        ...(input.privacyStatus ? { privacyStatus: input.privacyStatus } : {}),
      })
      .where(
        and(
          eq(videos.id, input.videoId),
          eq(videos.userId, input.userId),
          inArray(videos.status, [...input.fromStates]),
          sql`${videos.publishedVideoId} is null`,
        ),
      )
      .returning({ id: videos.id });

    if (!claimed) {
      const [row] = await tx
        .select({ status: videos.status })
        .from(videos)
        .where(and(eq(videos.id, input.videoId), eq(videos.userId, input.userId)))
        .limit(1);
      return row ? { ok: false, reason: "bad_state", status: row.status } : { ok: false, reason: "not_found" };
    }

    const { job, created } = await enqueueJob(tx, { userId: input.userId, videoId: input.videoId, type: "publish", runAt: input.runAt });
    return { ok: true, jobId: job.id, jobCreated: created };
  });
}
