/**
 * Task `metadata.generate` (payload { videoId, mode?, quotaConsumed?, humanize? }).
 *
 *  mode "scheduled" (default): enqueued by the scheduling module with dedupeKey `metadata:<videoId>`
 *    and runAt = videos.metadata_scheduled_at. Ports Convex generateForUpload(autoMarkReady=true).
 *    Idempotent: it only proceeds while `metadata_scheduled_at` is still set (manual regeneration,
 *    cancel and an earlier completed run all clear it), and the final write is a compare-and-swap
 *    on that column, so a run that raced with a manual regeneration never overwrites fresh results.
 *  mode "manual": handed over by the `metadata.generateForUpload` rpc action when the slow Files API
 *    is needed. The rpc already consumed the quota (`quotaConsumed`); the video status is untouched.
 *
 * Quota: consumed once per attempt and refunded on every failure (the Convex version leaked a unit
 * per failed attempt); a manual run keeps the rpc's unit across retries and refunds only when it
 * finally fails.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";
import { NonRetryableError, type HandlerCtx } from "@/server/jobs/handlers";
import type { TaskRow } from "@/server/jobs/queue";
import { isPermanentAiError } from "@/server/lib/ai";
import { saveVideoMetadata } from "@/server/lib/ai/metadata";
import { consumeQuota, refundQuota } from "@/server/lib/usage";
import { METADATA_LIMIT_MESSAGE, isPlanLimitError, isUuid, safeMessage } from "./common";
import { announceMetadata, clearMetadataSchedule, generateVideoMetadata } from "./metadataRuns";

/** Wall-clock budget for one attempt (frames are seconds; the Files API fallback is the long pole). */
const TASK_BUDGET_MS = 120_000;

type Payload = { videoId: string; mode: "scheduled" | "manual"; quotaConsumed: boolean; humanize?: boolean };

function parsePayload(raw: Record<string, unknown>): Payload {
  if (!isUuid(raw.videoId)) throw new NonRetryableError("metadata.generate: invalid payload (videoId)");
  return {
    videoId: raw.videoId,
    mode: raw.mode === "manual" ? "manual" : "scheduled",
    quotaConsumed: raw.quotaConsumed === true,
    humanize: typeof raw.humanize === "boolean" ? raw.humanize : undefined,
  };
}

/** Save results and (scheduled mode) flip draft -> ready, only if the schedule is still ours. */
async function commitScheduled(db: DbLike, videoId: string, meta: Parameters<typeof saveVideoMetadata>[2]): Promise<boolean> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(videos)
      .set({ metadataScheduledAt: null, status: "ready", updatedAt: new Date() })
      .where(and(eq(videos.id, videoId), isNotNull(videos.metadataScheduledAt), eq(videos.status, "draft")))
      .returning({ id: videos.id });
    if (claimed.length === 0) return false;
    await saveVideoMetadata(tx, videoId, meta);
    return true;
  });
}

export async function runMetadataTask(task: TaskRow, ctx: HandlerCtx): Promise<void> {
  const { db } = ctx;
  const p = parsePayload(task.payload);
  const finalAttempt = task.attempts >= task.maxAttempts;

  const [video] = await db.select().from(videos).where(eq(videos.id, p.videoId)).limit(1);
  if (!video) return; // deleted since scheduling

  if (p.mode === "scheduled") {
    if (!video.metadataScheduledAt) return; // cancelled, superseded by a manual run, or already done
    if (video.status !== "draft") {
      await clearMetadataSchedule(db, video.id); // processed some other way since scheduling
      return;
    }
  }

  const title = video.aiTitle ?? video.title;
  const fail = async (message: string) => {
    if (p.mode === "scheduled") await clearMetadataSchedule(db, video.id);
    await announceMetadata(db, video, title, { ok: false, error: message });
  };

  let consumedHere = false;
  if (!p.quotaConsumed) {
    try {
      await consumeQuota(db, video.userId, "metadataGenerated");
      consumedHere = true;
    } catch (e) {
      if (isPlanLimitError(e)) {
        await fail(METADATA_LIMIT_MESSAGE);
        return;
      }
      throw e;
    }
  }
  const refund = async (final: boolean) => {
    // Own unit: always hand it back. The rpc's unit: only once we give up for good.
    if (consumedHere || (p.quotaConsumed && final)) await refundQuota(db, video.userId, "metadataGenerated").catch(() => {});
  };

  try {
    const meta = await generateVideoMetadata(db, video, { humanize: p.humanize, allowFilesApi: true, budgetMs: TASK_BUDGET_MS });

    if (p.mode === "scheduled") {
      if (!(await commitScheduled(db, video.id, meta))) {
        await refund(true); // superseded while Gemini was working: keep the user's newer result
        return;
      }
    } else {
      await saveVideoMetadata(db, video.id, meta);
      await clearMetadataSchedule(db, video.id);
    }
    await announceMetadata(db, video, meta.title, { ok: true });
  } catch (e) {
    const permanent = isPermanentAiError(e);
    await refund(permanent || finalAttempt);
    if (permanent || finalAttempt) {
      await fail(safeMessage(e));
      if (permanent) return; // nothing a retry could change; the task is done
    }
    throw e; // retry with backoff
  }
}
