/**
 * Backfill `videos.duration` from Cloudinary for the caller's videos, and auto-switch long videos
 * (> 60s) to "video" mode so YouTube does not treat them as Shorts (Content ID rules differ).
 *
 * Port of convex/actions/backfillDurations.ts. It no longer lists the whole Cloudinary account:
 * it looks up only the needed public ids, in bounded batches, inside a time budget. A run that
 * cannot finish returns what it did; run it again to continue (done videos drop out of the set).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";
import { extractCloudinaryPublicId, fetchCloudinaryDurations, isAllowedMediaUrl } from "@/server/lib/cloudinary";
import type { FetchLike } from "@/server/lib/youtube";

export type BackfillResult = { updated: number; switched: number; skipped: number; total: number; remaining: number };

const MAX_PER_RUN = 300;
/** Rows per UPDATE ... FROM (VALUES ...): 3 bind parameters each, far below Postgres's 65535 limit. */
const UPDATE_CHUNK = 1000;

type DurationUpdate = { id: string; duration: number; switchToVideo: boolean };

/**
 * Write the resolved durations with one statement per chunk instead of one UPDATE per video.
 * Same guards as the per-row update: the row must belong to `userId` and still have no duration.
 * `publish_as` only changes where the flag (computed in JS from the pre-read value) says so.
 */
async function applyDurations(db: DbLike, userId: string, updates: DurationUpdate[]): Promise<void> {
  // The app clock, as an ISO string (what Drizzle's own Date mapping sends), like the per-row `new Date()` did.
  // Not now(): inside a transaction that is the transaction's start time.
  const stamp = new Date().toISOString();
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const values = sql.join(
      updates.slice(i, i + UPDATE_CHUNK).map((u) => sql`(${u.id}::uuid, ${u.duration}::float8, ${u.switchToVideo}::boolean)`),
      sql`, `,
    );
    await db.execute(sql`
      update videos v
      set duration = d.dur,
          updated_at = ${stamp}::timestamptz,
          publish_as = case when d.sw then 'video' else v.publish_as end
      from (values ${values}) as d(id, dur, sw)
      where v.id = d.id and v.user_id = ${userId}::uuid and v.duration is null
    `);
  }
}

export async function backfillDurationsForUser(
  db: DbLike,
  userId: string,
  opts: { f?: FetchLike; budgetMs?: number; maxPerRun?: number } = {},
): Promise<BackfillResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 25_000);
  const maxPerRun = opts.maxPerRun ?? MAX_PER_RUN;

  // Same filter as Convex: no duration yet, still on Cloudinary, file not deleted after publishing.
  // Only the batch comes back; `count(*) over ()` is evaluated before LIMIT, so it is the number of ALL eligible
  // videos (it is the same on every returned row, and there are no rows exactly when nothing is eligible).
  // LIMIT 0 would hide that count, hence the floor of 1 here and the slice below.
  const rows = await db
    .select({
      id: videos.id,
      rawFileKey: videos.rawFileKey,
      processedFileKey: videos.processedFileKey,
      publishAs: videos.publishAs,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(videos)
    .where(
      and(
        eq(videos.userId, userId),
        isNull(videos.duration),
        isNull(videos.cloudinaryDeletedAt),
        sql`${videos.rawFileKey} like '%res.cloudinary.com%'`,
      ),
    )
    .orderBy(sql`${videos.createdAt} desc`)
    .limit(Math.max(1, maxPerRun));

  const total = rows[0]?.total ?? 0;
  if (total === 0) return { updated: 0, switched: 0, skipped: 0, total: 0, remaining: 0 };

  const batch = rows.slice(0, maxPerRun);
  const idFor = new Map<string, string | null>();
  for (const v of batch) {
    const url = isAllowedMediaUrl(v.processedFileKey) ? v.processedFileKey : v.rawFileKey;
    idFor.set(v.id, isAllowedMediaUrl(url) ? extractCloudinaryPublicId(url) : null);
  }
  const publicIds = [...new Set([...idFor.values()].filter((p): p is string => !!p))];
  const durations = await fetchCloudinaryDurations(publicIds, { f: opts.f, deadline });

  let updated = 0;
  let switched = 0;
  let skipped = 0;
  const updates: DurationUpdate[] = [];
  for (const v of batch) {
    const publicId = idFor.get(v.id);
    const dur = publicId ? durations.get(publicId) : undefined;
    if (!dur) {
      skipped++;
      continue;
    }
    // Auto-switch videos > 60s to Video mode unless the user already chose a mode.
    const switchToVideo = dur > 60 && !v.publishAs;
    updates.push({ id: v.id, duration: dur, switchToVideo });
    // Counted when resolved, as before, even if the guarded update then finds the row already filled in.
    updated++;
    if (switchToVideo) switched++;
  }
  if (updates.length > 0) await applyDurations(db, userId, updates);
  return { updated, switched, skipped, total, remaining: total - updated };
}
