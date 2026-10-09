/**
 * Periodic publishing duties (the Convex `crons.ts` "process scheduled publishes" replacement).
 */
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { enqueueJob } from "@/server/jobs/queue";
import { bestEffort, defaultDeps, type PublishDeps } from "./deps";

type Claimed = { id: string; user_id: string };

export type DueSchedulesOptions = {
  /** Test seam: only consider this user's / these videos. Production passes nothing. */
  userId?: string;
  videoIds?: string[];
  /** Test seam: when the created jobs become runnable (default now). */
  runAt?: Date;
  batchSize?: number;
  maxBatches?: number;
};

/**
 * Turn every due scheduled video into a publish job.
 *
 * Each batch is ONE transaction: `UPDATE ... SET status='publishing' ... FOR UPDATE SKIP LOCKED
 * RETURNING` claims the rows (concurrent sweeps get disjoint sets and never wait), then a job is
 * enqueued for each claimed row. A crash rolls both back, so a video is never left "publishing"
 * without a job; the DB allows one active publish job per video, so duplicates are impossible.
 */
export async function processDueSchedules(db: DbLike, opts: DueSchedulesOptions = {}): Promise<{ claimed: number; jobsCreated: number }> {
  const batchSize = opts.batchSize ?? 200;
  const maxBatches = opts.maxBatches ?? 10;
  const userFilter = opts.userId ? sql`and user_id = ${opts.userId}` : sql``;
  const idFilter =
    opts.videoIds && opts.videoIds.length > 0 ? sql`and id in (${sql.join(opts.videoIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  let claimed = 0;
  let jobsCreated = 0;

  for (let i = 0; i < maxBatches; i++) {
    const batch = await db.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        update videos
           set status = 'publishing', updated_at = now()
         where id in (
           select id from videos
            where status = 'scheduled' and scheduled_publish_at <= now() and published_video_id is null
              ${userFilter} ${idFilter}
            order by scheduled_publish_at
            limit ${batchSize}
              for update skip locked
         )
        returning id, user_id
      `)) as unknown as Claimed[];
      let created = 0;
      for (const r of rows) {
        const { created: isNew } = await enqueueJob(tx, { userId: r.user_id, videoId: r.id, type: "publish", runAt: opts.runAt });
        if (isNew) created++;
      }
      return { n: rows.length, created };
    });
    claimed += batch.n;
    jobsCreated += batch.created;
    if (batch.n < batchSize) break;
  }
  return { claimed, jobsCreated };
}

/** A video is "publishing" only while a publish job is alive. Anything else for this long is stuck. */
const STUCK_AFTER_MINUTES = 15;

type Stuck = { id: string; user_id: string; title: string; ai_title: string | null };

/**
 * Repair videos whose job vanished (a run killed on its last attempt is failed by the queue's stale
 * recovery without our handler running again):
 *  - 'publishing', no YouTube id, no live job for 15+ minutes  -> 'failed' + tell the user;
 *  - has a YouTube id but is not 'published', no live job      -> 'published'.
 * The 15-minute window also means it can never race a job being created.
 */
export async function reconcilePublishing(
  db: DbLike,
  deps: PublishDeps = defaultDeps(),
  opts: { videoIds?: string[] } = {},
): Promise<{ failed: number; published: number }> {
  // Test seam: restrict to explicit videos so a test never locks the shared database's other rows.
  const only =
    opts.videoIds && opts.videoIds.length > 0 ? sql`and v.id in (${sql.join(opts.videoIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
  const noLiveJob = sql`not exists (
    select 1 from jobs j where j.video_id = v.id and j.type = 'publish' and j.status in ('pending', 'processing')
  )`;

  const published = (await db.execute(sql`
    update videos v set status = 'published', updated_at = now()
     where v.status = 'publishing' and v.published_video_id is not null
       and v.updated_at < now() - ${STUCK_AFTER_MINUTES} * interval '1 minute' and ${noLiveJob} ${only}
    returning v.id
  `)) as unknown as unknown[];

  const stuck = (await db.execute(sql`
    update videos v set status = 'failed', updated_at = now()
     where v.status = 'publishing' and v.published_video_id is null
       and v.updated_at < now() - ${STUCK_AFTER_MINUTES} * interval '1 minute' and ${noLiveJob} ${only}
    returning v.id, v.user_id, v.title, v.ai_title
  `)) as unknown as Stuck[];

  for (const v of stuck) {
    const title = v.ai_title ?? v.title;
    const reason = "The publish did not finish (the server stopped before it completed). Try publishing again.";
    await bestEffort("stuck-video notification", () =>
      deps.createNotification(db, {
        userId: v.user_id,
        title: "Publish failed",
        message: `"${title}" could not be published: ${reason}`,
        type: "error",
        link: `/video/${v.id}`,
      }),
    );
    await bestEffort("stuck-video message", () =>
      deps.sendUserNotification(db, v.user_id, "publishFailure", { title, error: reason, attemptsLabel: "multiple attempts" }),
    );
  }
  return { failed: stuck.length, published: published.length };
}
