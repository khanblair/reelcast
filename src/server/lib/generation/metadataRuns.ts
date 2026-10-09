/**
 * Shared building blocks for every path that produces AI metadata for a video:
 * the `metadata.generate` task, the upload-analysis job, the post-Veo step and the
 * `metadata.generateForUpload` rpc action. Quota, status changes and scheduling stay with the callers.
 */
import { and, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { settings, videos } from "@/db/schema";
import { createGeminiClient } from "@/server/lib/ai";
import { generateMetadataFromPrompt, generateMetadataFromVideo, type VideoMetadata } from "@/server/lib/ai/metadata";
import { createNotification } from "@/server/lib/notifications";
import { sendUserNotification } from "@/server/lib/notify";
import { getPlatformKey } from "@/server/lib/platformKeys";
import { cancelTask } from "@/server/jobs/queue";
import { GeminiNotConfiguredError, safeMessage } from "./common";

export type VideoRow = typeof videos.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;

export const metadataTaskKey = (videoId: string) => `metadata:${videoId}`;

export async function loadSettings(db: DbLike, userId: string): Promise<SettingsRow | null> {
  const [row] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
  return row ?? null;
}

async function geminiFor(db: DbLike) {
  const key = await getPlatformKey(db, "gemini");
  if (!key) throw new GeminiNotConfiguredError();
  return createGeminiClient(key);
}

/** Frames (and, if allowed, the Files API) -> metadata. Does NOT save. */
export async function generateVideoMetadata(
  db: DbLike,
  video: Pick<VideoRow, "userId" | "rawFileKey" | "title" | "aiTitle">,
  opts: { humanize?: boolean | null; allowFilesApi: boolean; budgetMs: number },
): Promise<VideoMetadata> {
  const ai = await geminiFor(db);
  const s = await loadSettings(db, video.userId);
  return generateMetadataFromVideo(ai, {
    videoUrl: video.rawFileKey,
    hint: video.aiTitle ?? video.title,
    guidelines: s?.aiGuidelines,
    tone: s?.aiTone,
    humanize: opts.humanize ?? s?.humanizeWriting ?? false,
    deadlineAt: Date.now() + opts.budgetMs,
    allowFilesApi: opts.allowFilesApi,
    timeoutMs: Math.min(opts.budgetMs, 60_000),
  });
}

/** Prompt-only metadata (after a generated video completes). Does NOT save. */
export async function generatePromptMetadata(
  db: DbLike,
  video: Pick<VideoRow, "userId" | "title">,
  prompt: string,
): Promise<VideoMetadata> {
  const ai = await geminiFor(db);
  const s = await loadSettings(db, video.userId);
  return generateMetadataFromPrompt(ai, { prompt, humanize: s?.humanizeWriting ?? false, fallbackTitle: video.title });
}

/**
 * A manual/bulk regeneration (or a finished run) makes a queued metadata job redundant; leaving it
 * alive would overwrite the fresh results. Clears the column and cancels the pending task.
 */
export async function clearMetadataSchedule(db: DbLike, videoId: string): Promise<void> {
  await db.update(videos).set({ metadataScheduledAt: null, updatedAt: new Date() }).where(eq(videos.id, videoId));
  await cancelTask(db, metadataTaskKey(videoId));
}

/** Flip a draft to ready only if it is still a draft (never regress a video that moved on). */
export async function markReadyIfDraft(db: DbLike, videoId: string): Promise<boolean> {
  const rows = await db
    .update(videos)
    .set({ status: "ready", updatedAt: new Date() })
    .where(and(eq(videos.id, videoId), eq(videos.status, "draft")))
    .returning({ id: videos.id });
  return rows.length > 0;
}

/**
 * Tell the user how metadata generation went: in-app bell + external channels (per their
 * toggles). Best effort - never throws.
 */
export async function announceMetadata(
  db: DbLike,
  video: Pick<VideoRow, "id" | "userId">,
  title: string,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  const link = `/video/${video.id}`;
  try {
    await createNotification(
      db,
      outcome.ok
        ? { userId: video.userId, title: "Metadata ready", message: `AI metadata for "${title}" is ready for review.`, type: "success", link }
        : { userId: video.userId, title: "Metadata generation failed", message: `"${title}": ${safeMessage(outcome.error, 200)}`, type: "error", link },
    );
  } catch (e) {
    console.error("[metadata] createNotification failed:", safeMessage(e, 120));
  }
  await sendUserNotification(
    db,
    video.userId,
    "metadataReady",
    outcome.ok ? { title, videoId: video.id, status: "ready" } : { title, videoId: video.id, status: "failed", error: safeMessage(outcome.error, 200) },
  );
}
