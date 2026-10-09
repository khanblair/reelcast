/**
 * Auto-publish: every N hours (or at fixed local time slots) publish the next few ready videos of a
 * user. Port of convex/actions/autoPublish.ts `runAutoPublishBatch` as the `autoPublish.run` TASK.
 *
 * The chain must never die silently, so this handler:
 *  - catches batch errors, records them on the task row, and STILL schedules the next run;
 *  - schedules the next run by returning `{ rescheduleInMs }` (the queue re-pends this very task row).
 *    It cannot enqueue a new task under the same dedupe key: while this task is 'running' it still
 *    owns the key, so `enqueueTask` would just hand this row back and the chain would end.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/client";
import { settings, tasks, videos } from "@/db/schema";
import { NonRetryableError } from "@/server/jobs/handlers";
import type { TaskRow } from "@/server/jobs/queue";
import { claimAndEnqueuePublish } from "./claim";
import { bestEffort, defaultDeps, type PublishDeps } from "./deps";
import { computeNextAutoPublishAt } from "./schedule";
import { setStorageHealth } from "./storage";

const payloadSchema = z.object({ userId: z.string().uuid() });
const MIN_RESCHEDULE_MS = 5_000;

export type AutoPublishCtx = { db: DbLike; now: Date };
export type AutoPublishResult = void | { rescheduleInMs: number };

type Privacy = NonNullable<(typeof settings.$inferSelect)["autoPublishPrivacy"]>;

/** The user's ready videos in queue order: publish_order ascending (unordered last), then oldest first. */
export async function listReadyInQueueOrder(db: DbLike, userId: string, limit: number) {
  return db
    .select()
    .from(videos)
    .where(and(eq(videos.userId, userId), eq(videos.status, "ready")))
    .orderBy(sql`${videos.publishOrder} asc nulls last`, sql`${videos.createdAt} asc`)
    .limit(limit);
}

/** One batch: verify files, claim + enqueue up to `count` publishes. Throws only on infrastructure errors. */
async function runBatch(db: DbLike, deps: PublishDeps, userId: string, s: typeof settings.$inferSelect): Promise<{ queued: number }> {
  const count = Math.max(1, s.autoPublishCount ?? 1);
  const privacy: Privacy = s.autoPublishPrivacy ?? "public";

  // Over-fetch: a run capped at exactly `count` could pull only known-dead videos and publish
  // nothing while healthy videos wait further back in the queue.
  const candidates = await listReadyInQueueOrder(db, userId, Math.max(count * 5, 25));

  // Freshly verify each candidate right before selecting (a stale flag would miss files that died
  // since the last check). Videos already confirmed dead skip the network call.
  const checked = await Promise.all(
    candidates.map(async (video) => {
      const wasMissing = video.storageMissing === true;
      const missing = wasMissing || (await deps.isFileMissing(video.processedFileKey ?? video.rawFileKey));
      if (missing !== wasMissing) await setStorageHealth(db, video.id, missing);
      return { video, missing, newlyDetected: missing && !wasMissing };
    }),
  );

  const newlyDead = checked.filter((c) => c.newlyDetected);
  const selected = checked.filter((c) => !c.missing).map((c) => c.video).slice(0, count);

  // Tell the user, once per video, right when it is first found dead; otherwise the skip is silent.
  if (newlyDead.length > 0) {
    const titles = newlyDead.map((c) => c.video.aiTitle ?? c.video.title);
    const plural = newlyDead.length === 1;
    await bestEffort("storage warning", () =>
      deps.sendUserNotification(db, userId, "storageWarning", {
        titles,
        message:
          `⚠️ Auto-publish found ${newlyDead.length} video(s) with a missing storage file and skipped ${plural ? "it" : "them"}:\n` +
          `${titles.map((t) => `• ${t}`).join("\n")}\n\n` +
          `Re-upload to publish. Other queued videos will now publish sooner since they no longer wait behind ${plural ? "this one" : "these"}.`,
      }),
    );
  }

  let queued = 0;
  for (const video of selected) {
    try {
      // Claim + job in one transaction: either both happen or neither (no rollback code needed).
      const r = await claimAndEnqueuePublish(db, { userId, videoId: video.id, fromStates: ["ready"], privacyStatus: privacy });
      if (r.ok) queued++; // not ok = taken by publish-now / a concurrent run
    } catch (err) {
      console.error(`[autoPublish] failed to queue video ${video.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { queued };
}

export async function runAutoPublish(task: TaskRow, ctx: AutoPublishCtx, deps: PublishDeps = defaultDeps()): Promise<AutoPublishResult> {
  const { db } = ctx;
  const parsed = payloadSchema.safeParse({ userId: (task.payload as Record<string, unknown> | null)?.userId ?? task.userId });
  if (!parsed.success) throw new NonRetryableError("autoPublish.run needs a payload { userId }");
  const { userId } = parsed.data;

  const [s] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  if (!s?.autoPublishEnabled) return; // stopped: the chain ends here

  try {
    await runBatch(db, deps, userId, s);
  } catch (err) {
    console.error(`[autoPublish] batch failed for user ${userId}:`, err instanceof Error ? err.message : err);
    await bestEffort("record task error", () =>
      db.update(tasks).set({ lastError: err instanceof Error ? err.message : String(err), updatedAt: new Date() }).where(eq(tasks.id, task.id)),
    );
  }

  // Next run. The user may have stopped or restarted auto-publish while the batch ran, so write
  // our time only if next_at is still what we read (compare-and-swap), else adopt theirs.
  const now = new Date();
  const computed = computeNextAutoPublishAt(s, now);
  const startNext = s.autoPublishNextAt;
  const swapped = await db
    .update(settings)
    .set({ autoPublishNextAt: computed, updatedAt: new Date() })
    .where(
      and(
        eq(settings.userId, userId),
        eq(settings.autoPublishEnabled, true),
        startNext ? eq(settings.autoPublishNextAt, startNext) : sql`${settings.autoPublishNextAt} is null`,
      ),
    )
    .returning({ id: settings.id });

  let nextAt = computed;
  if (swapped.length === 0) {
    const [again] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
    if (!again?.autoPublishEnabled) return; // stopped during the batch
    if (again.autoPublishNextAt && again.autoPublishNextAt.getTime() > now.getTime()) {
      nextAt = again.autoPublishNextAt; // restarted with a new schedule while we ran: honour it
    } else {
      // Not changed by the user (the swap only missed on timestamp precision): store our time.
      await db
        .update(settings)
        .set({ autoPublishNextAt: computed, updatedAt: new Date() })
        .where(and(eq(settings.userId, userId), eq(settings.autoPublishEnabled, true)));
    }
  }

  return { rescheduleInMs: Math.max(MIN_RESCHEDULE_MS, nextAt.getTime() - Date.now()) };
}

