/**
 * Weekly digest (replaces the Convex "weekly digest notifications" cron + sendWeeklyDigestToAll).
 *
 *  sweep `weekly-digest` (15 min)  acts only in the Sunday 08:00-08:59 UTC window and enqueues ONE
 *                                  `digest.batch` task per ISO week (marker `digest-week:<week>`).
 *  task  `digest.batch`            walks eligible users in id order, BATCH_SIZE per run, and reschedules
 *                                  itself with a cursor until the list is exhausted.
 *
 * Exactly-once per user per week: before doing anything for a user the batch inserts a marker row
 * `digest:<userId>:<week>` into job_schedules (PRIMARY KEY on name, ON CONFLICT DO NOTHING). Only the
 * caller whose insert returns a row proceeds, so concurrent sweeps / retried batches can never send
 * twice. The price is at-most-once: a crash between the marker and the send drops that user's digest
 * for the week rather than duplicating it.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";
import type { HandlerCtx } from "@/server/jobs/handlers";
import { enqueueTask, type TaskRow } from "@/server/jobs/queue";
import { sendUserNotification } from "@/server/lib/notify";
import { isUuid, safeMessage } from "./common";

export const DIGEST_BATCH_KIND = "digest.batch";
export const DIGEST_SWEEP_NAME = "weekly-digest";
export const DIGEST_SWEEP_EVERY_MS = 15 * 60_000;
const BATCH_SIZE = 20;
const SEND_CONCURRENCY = 5;
const MARKER_TTL_DAYS = 60;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** "YYYY-Www" (ISO 8601 week, UTC). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Sunday 08:00-08:59 UTC (the Convex cron fired at 08:00 UTC on Sundays). */
export function inDigestWindow(d: Date): boolean {
  return d.getUTCDay() === 0 && d.getUTCHours() === 8;
}

const markerName = (userId: string, week: string) => `digest:${userId}:${week}`;

/** Atomically claim the (user, week) slot. true = this caller owns it. */
export async function claimDigestMarker(db: DbLike, userId: string, week: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    insert into job_schedules (name, last_run_at) values (${markerName(userId, week)}, now())
    on conflict (name) do nothing
    returning name
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * The sweep body. It runs every few minutes (tick granularity is one minute and a strictly hourly
 * cadence drifts, so it could straddle the one-hour window and skip a week); it acts only inside the
 * window and opens it exactly once per ISO week via a `digest-week:<week>` marker, committed in the same
 * transaction as the batch task so a failed enqueue leaves the week open for the next run.
 */
export async function runDigestSweep(ctx: HandlerCtx): Promise<void> {
  const { db, now } = ctx;
  if (!inDigestWindow(now)) return;
  const week = isoWeekKey(now);
  await db.execute(sql`
    delete from job_schedules
    where (name like 'digest:%' or name like 'digest-week:%') and last_run_at < now() - ${MARKER_TTL_DAYS} * interval '1 day'
  `);
  await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      insert into job_schedules (name, last_run_at) values (${`digest-week:${week}`}, now())
      on conflict (name) do nothing
      returning name
    `)) as unknown as unknown[];
    if (rows.length === 0) return; // this week's batch was already opened
    await enqueueTask(tx, { kind: DIGEST_BATCH_KIND, payload: { week, after: null }, dedupeKey: `digest-batch:${week}` });
  });
}

type Stats = { videosPublished: number; totalViews?: number; topVideoTitle?: string; topVideoViews?: number };

/** Digest numbers for one user over the last 7 days; null when nothing was published (skip, as Convex did). */
async function weeklyStats(db: DbLike, userId: string, now: Date): Promise<Stats | null> {
  const since = new Date(now.getTime() - WEEK_MS);
  const published = await db
    .select({ id: videos.id, title: videos.title, aiTitle: videos.aiTitle })
    .from(videos)
    .where(and(eq(videos.userId, userId), eq(videos.status, "published"), gte(videos.publishedAt, since)));
  if (published.length === 0) return null;

  const stats: Stats = { videosPublished: published.length };
  try {
    // Latest snapshot per video (analytics are best effort: never block the digest).
    const rows = (await db.execute(sql`
      select distinct on (video_id) video_id, views
      from video_analytics
      where video_id in (${sql.join(published.map((p) => sql`${p.id}`), sql`, `)})
      order by video_id, day desc, fetched_at desc
    `)) as unknown as { video_id: string; views: number | null }[];
    if (rows.length > 0) {
      stats.totalViews = rows.reduce((sum, r) => sum + (r.views ?? 0), 0);
      const best = [...rows].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];
      if (best && (best.views ?? 0) > 0) {
        const v = published.find((p) => p.id === best.video_id);
        if (v) {
          stats.topVideoTitle = v.aiTitle || v.title;
          stats.topVideoViews = best.views ?? 0;
        }
      }
    }
  } catch (e) {
    console.error("[digest] analytics lookup failed:", safeMessage(e, 120));
  }
  return stats;
}

/** Users who opted in and have somewhere to receive it (Telegram, Discord or email) and a connected channel. */
async function eligibleUsers(db: DbLike, after: string | null, limit: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    select s.user_id
    from settings s
    where s.notifications_enabled
      and s.notify_on_weekly_digest
      and (
        s.telegram_chat_id is not null
        or s.discord_webhook_url is not null
        or (s.email_notifications_enabled and s.resend_api_key is not null)
      )
      and exists (select 1 from youtube_channels c where c.user_id = s.user_id)
      and (${after}::uuid is null or s.user_id > ${after}::uuid)
    order by s.user_id
    limit ${limit}
  `)) as unknown as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

export type DigestBatchResult = { processed: number; sent: number; last: string | null };

/** Process one page of users. `week` is the key the markers are filed under. */
export async function runDigestPage(
  db: DbLike,
  week: string,
  after: string | null,
  now: Date,
  limit = BATCH_SIZE,
): Promise<DigestBatchResult> {
  const ids = await eligibleUsers(db, after, limit);
  let sent = 0;
  for (let i = 0; i < ids.length; i += SEND_CONCURRENCY) {
    const group = ids.slice(i, i + SEND_CONCURRENCY);
    const results = await Promise.all(
      group.map(async (userId) => {
        try {
          if (!(await claimDigestMarker(db, userId, week))) return false; // already handled this week
          const stats = await weeklyStats(db, userId, now);
          if (!stats) return false;
          await sendUserNotification(db, userId, "weeklyDigest", stats);
          return true;
        } catch (e) {
          console.error("[digest] user failed:", safeMessage(e, 120));
          return false;
        }
      }),
    );
    sent += results.filter(Boolean).length;
  }
  return { processed: ids.length, sent, last: ids.length ? ids[ids.length - 1] : null };
}

/** Task handler for `digest.batch`. */
export async function runDigestBatchTask(task: TaskRow, ctx: HandlerCtx): Promise<void | { rescheduleInMs: number; payload: Record<string, unknown> }> {
  const week = typeof task.payload.week === "string" ? task.payload.week : isoWeekKey(ctx.now);
  const after = isUuid(task.payload.after) ? task.payload.after : null;
  const page = await runDigestPage(ctx.db, week, after, ctx.now);
  if (page.processed < BATCH_SIZE || !page.last) return; // exhausted
  return { rescheduleInMs: 2_000, payload: { week, after: page.last } };
}
