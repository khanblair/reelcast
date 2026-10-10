/**
 * The auto-publish chain: its dedupe key, the one place that (re)queues a run, and the sweep that restarts a dead chain.
 *
 * A chain is ONE `autoPublish.run` task row per user that re-pends itself after every run (see ./autoPublish.ts). The
 * handler is written so that no error ends it, but a worker that dies on its last attempt, or a task cancelled by hand,
 * still can. The user would then see "auto-publish on" and a next run that has long passed, and nothing would ever run
 * again. `recoverAutoPublishChains` finds exactly those users and queues their run again.
 *
 * Kept free of the publish runtime's imports (only the queue), because the settings RPC module imports it too.
 */
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { enqueueTask } from "@/server/jobs/queue";
import { safeErrorMessage } from "@/server/lib/safe-error";

export const AUTO_PUBLISH_KIND = "autoPublish.run";
const KEY_PREFIX = "autoPublish:";

/** `tasks.dedupe_key` of a user's chain: while a pending/running task has it, queueing the chain again is a no-op. */
export const autoPublishKey = (userId: string) => `${KEY_PREFIX}${userId}`;

/**
 * Queue a user's run for `runAt`, or hand back the live one (`created: false`). Used when the user starts auto-publish
 * and when a dead chain is restarted, so both write the same row under the same key.
 */
export function enqueueAutoPublishRun(db: DbLike, userId: string, runAt: Date) {
  return enqueueTask(db, { kind: AUTO_PUBLISH_KIND, userId, payload: { userId }, runAt, dedupeKey: autoPublishKey(userId) });
}

/** A chain is only suspect once its next run is this much overdue (a busy tick can run a due task a few minutes late). */
export const RECOVER_OVERDUE_MS = 10 * 60_000;
/** Most chains restarted per sweep run. If more are dead the rest follow on later runs, most overdue first. */
export const RECOVER_BATCH = 20;

export type RecoverOptions = {
  limit?: number;
  /** Test seam: look at these users only. Production passes nothing. */
  userIds?: string[];
};

export type RecoverResult = { found: number; restarted: number; failed: string[] };

/**
 * Restart the chain of every user who has auto-publish ON, whose next run is more than 10 minutes overdue, and who has no
 * live (pending/running) run. Finding them is ONE statement (settings_auto_publish_idx for the first two conditions, the
 * partial unique index tasks_dedupe_idx for the third); each user found costs one enqueue, at most `limit` per run.
 *
 * Safe to run twice at once: the enqueue is `ON CONFLICT DO NOTHING` on the dedupe key, so a second caller (or a user
 * pressing Start at the same moment) gets the live row back instead of a duplicate. It never cancels anything.
 * Users with auto-publish off, with no next run, or whose next run is not yet overdue are never touched.
 */
export async function recoverAutoPublishChains(db: DbLike, now: Date, opts: RecoverOptions = {}): Promise<RecoverResult> {
  const limit = opts.limit ?? RECOVER_BATCH;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("recoverAutoPublishChains: limit must be a positive integer");
  if (opts.userIds !== undefined && (opts.userIds.length === 0 || opts.userIds.some((id) => typeof id !== "string" || id === ""))) {
    throw new Error("recoverAutoPublishChains: userIds, when given, must be a non-empty list of ids");
  }
  const only = opts.userIds ? sql`and s.user_id in (${sql.join(opts.userIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  const cutoff = new Date(now.getTime() - RECOVER_OVERDUE_MS).toISOString();

  const rows = (await db.execute(sql`
    select s.user_id
      from settings s
     where s.auto_publish_enabled
       and s.auto_publish_next_at < ${cutoff}::timestamptz
       and not exists (
         select 1 from tasks t
          where t.dedupe_key = ${KEY_PREFIX}::text || s.user_id::text and t.status in ('pending', 'running')
       )
       ${only}
     order by s.auto_publish_next_at
     limit ${limit}
  `)) as unknown as { user_id: string }[];

  const result: RecoverResult = { found: rows.length, restarted: 0, failed: [] };
  for (const { user_id: userId } of rows) {
    try {
      const { created } = await enqueueAutoPublishRun(db, userId, now);
      if (created) {
        result.restarted++;
        console.warn(`[autoPublish.recover] restarted the chain of user ${userId}`);
      }
    } catch (err) {
      // One user's failure must not keep the others from being restarted.
      result.failed.push(`${userId}: ${safeErrorMessage(err)}`);
    }
  }
  return result;
}
