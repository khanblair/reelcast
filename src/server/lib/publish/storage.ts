/**
 * Storage health: is the video file still on Cloudinary? Shared by the user/admin health checks,
 * auto-publish (fresh check right before selecting) and the publish job (a 404 mid-upload).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";

/**
 * Record a health result in ONE statement. A confirmed-missing file can never be published, so a
 * ready/scheduled video is demoted to 'failed' instead of sitting in the queue with a dead link;
 * other statuses are left alone.
 */
export async function setStorageHealth(db: DbLike, videoId: string, storageMissing: boolean): Promise<void> {
  await db.execute(sql`
    update videos
       set storage_missing = ${storageMissing},
           storage_checked_at = now(),
           status = case when ${storageMissing} and status in ('ready', 'scheduled') then 'failed' else status end,
           updated_at = now()
     where id = ${videoId}
  `);
}

export type StorageTarget = { id: string; rawFileKey: string; processedFileKey: string | null };
export type StorageHealthResult = { checked: number; missing: number; healthy: number };

/** Ready + scheduled videos (optionally one user's), least-recently-checked first so repeated runs rotate through a large set. */
export async function listPublishableTargets(db: DbLike, opts: { userId?: string; limit?: number } = {}): Promise<StorageTarget[]> {
  const cond = and(inArray(videos.status, ["ready", "scheduled"]), opts.userId ? eq(videos.userId, opts.userId) : undefined);
  return db
    .select({ id: videos.id, rawFileKey: videos.rawFileKey, processedFileKey: videos.processedFileKey })
    .from(videos)
    .where(cond)
    .orderBy(sql`${videos.storageCheckedAt} asc nulls first`, asc(videos.createdAt))
    .limit(opts.limit ?? 1000);
}

/**
 * HEAD-check each target (6 at a time) and record the result. Stops starting new batches at
 * `deadline` and reports how many were actually checked, so a large queue never outlives the
 * request: calling again continues with the unchecked ones.
 */
export async function checkTargets(
  db: DbLike,
  targets: StorageTarget[],
  isMissing: (url: string) => Promise<boolean>,
  opts: { deadline?: number; concurrency?: number } = {},
): Promise<StorageHealthResult> {
  const concurrency = opts.concurrency ?? 6;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  let checked = 0;
  let missing = 0;
  for (let i = 0; i < targets.length && Date.now() < deadline; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (t) => {
        const gone = await isMissing(t.processedFileKey ?? t.rawFileKey);
        await setStorageHealth(db, t.id, gone);
        return gone;
      }),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[storage] check failed:", r.reason instanceof Error ? r.reason.message : r.reason);
        continue;
      }
      checked++;
      if (r.value) missing++;
    }
  }
  return { checked, missing, healthy: checked - missing };
}
