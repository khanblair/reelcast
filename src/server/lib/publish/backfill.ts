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

export async function backfillDurationsForUser(
  db: DbLike,
  userId: string,
  opts: { f?: FetchLike; budgetMs?: number; maxPerRun?: number } = {},
): Promise<BackfillResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 25_000);

  // Same filter as Convex: no duration yet, still on Cloudinary, file not deleted after publishing.
  const eligible = await db
    .select({
      id: videos.id,
      rawFileKey: videos.rawFileKey,
      processedFileKey: videos.processedFileKey,
      publishAs: videos.publishAs,
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
    .orderBy(sql`${videos.createdAt} desc`);

  const total = eligible.length;
  if (total === 0) return { updated: 0, switched: 0, skipped: 0, total: 0, remaining: 0 };

  const batch = eligible.slice(0, opts.maxPerRun ?? MAX_PER_RUN);
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
  for (const v of batch) {
    const publicId = idFor.get(v.id);
    const dur = publicId ? durations.get(publicId) : undefined;
    if (!dur) {
      skipped++;
      continue;
    }
    // Auto-switch videos > 60s to Video mode unless the user already chose a mode.
    const switchToVideo = dur > 60 && !v.publishAs;
    await db
      .update(videos)
      .set({ duration: dur, updatedAt: new Date(), ...(switchToVideo ? { publishAs: "video" as const } : {}) })
      .where(and(eq(videos.id, v.id), eq(videos.userId, userId), isNull(videos.duration)));
    updated++;
    if (switchToVideo) switched++;
  }
  return { updated, switched, skipped, total, remaining: total - updated };
}
