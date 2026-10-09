/**
 * The `generation` job (replaces convex/scheduled/runGeneration.ts + convex/actions/generation.ts).
 *
 *  sourceType "generate"  Veo text-to-video as a resumable state machine. Every run does ONE bounded
 *                         step and returns `{ deferMs, metadata }` until the video is finished:
 *       submit   no generation row for this run yet  -> consume 'veoGenerated' quota, submit the
 *                operation (refund on failure), persist the operation name on BOTH the video and the
 *                generations row in one transaction, defer 15s.
 *       poll     generation row exists                -> poll the operation once; not done -> defer;
 *                done -> stream-download the Veo file, copy it to Cloudinary, mark the video ready.
 *     "This run" = the newest generations row created since the job first started (jobs.started_at is
 *     stable across defers and reset by a manual retry), so a crash/retry resumes instead of paying for
 *     a second operation, while a retry or a regeneration starts a fresh one.
 *  sourceType "upload"    Gemini metadata for an uploaded video (Convex processGenerationJob), one
 *                         bounded step (frames; Files API fallback under a hard deadline).
 *
 * Failure: a permanent error, or the last attempt, marks the video (and generation) failed; otherwise
 * the error is rethrown and the queue retries with backoff.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { generations, videos } from "@/db/schema";
import { NonRetryableError, type HandlerCtx, type JobResult } from "@/server/jobs/handlers";
import type { JobRow } from "@/server/jobs/queue";
import {
  isPermanentAiError,
  openVeoDownload,
  pollVeoOperation,
  submitVeoGeneration,
  type VeoGenerationParams,
  type VeoOperationResult,
} from "@/server/lib/ai";
import { saveVideoMetadata } from "@/server/lib/ai/metadata";
import { createNotification } from "@/server/lib/notifications";
import { sendUserNotification } from "@/server/lib/notify";
import { getPlatformKey } from "@/server/lib/platformKeys";
import { consumeQuota, refundQuota } from "@/server/lib/usage";
import { cloudinaryPosterUrl, uploadBytesToCloudinary, uploadResponseToCloudinary, type CloudinaryUploadResult } from "./cloudinaryUpload";
import { isPlanLimitError, safeMessage } from "./common";
import { announceMetadata, generatePromptMetadata, generateVideoMetadata, loadSettings, type VideoRow } from "./metadataRuns";

export const POLL_DEFER_MS = 15_000;
/** Convex polled 40 times at 15s (= 10 min). The tick may be slower than 15s, so wall-clock caps too. */
export const MAX_POLLS = 40;
export const MAX_GENERATION_MS = 10 * 60_000;
const ANALYSIS_BUDGET_MS = 120_000;
const VEO_LIMIT_MESSAGE = "Video generation limit reached for your plan. Upgrade to generate more videos.";

export type GenerationDeps = {
  submitVeo: (params: VeoGenerationParams, apiKey: string | null) => Promise<{ operationName: string }>;
  pollVeo: (operationName: string, apiKey: string | null) => Promise<VeoOperationResult>;
  downloadVeo: (uri: string, apiKey: string) => Promise<Response>;
  uploadStream: (res: Response, publicId: string, mimeType: string) => Promise<CloudinaryUploadResult>;
  uploadBytes: (bytes: Uint8Array<ArrayBuffer>, publicId: string, mimeType: string) => Promise<CloudinaryUploadResult>;
  now: () => number;
};

export const defaultGenerationDeps: GenerationDeps = {
  submitVeo: submitVeoGeneration,
  pollVeo: pollVeoOperation,
  downloadVeo: openVeoDownload,
  uploadStream: uploadResponseToCloudinary,
  uploadBytes: uploadBytesToCloudinary,
  now: () => Date.now(),
};

type GenerationRow = typeof generations.$inferSelect;
type Kind = "veo" | "analysis";

// ─── entry point ─────────────────────────────────────────────────────────────

export async function runGenerationJob(job: JobRow, ctx: HandlerCtx, deps: GenerationDeps = defaultGenerationDeps): Promise<JobResult> {
  const { db } = ctx;
  const [video] = await db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1);
  if (!video || video.userId !== job.userId) throw new NonRetryableError("Video not found");

  const kind: Kind = video.sourceType === "generate" ? "veo" : "analysis";
  try {
    return kind === "veo" ? await runVeo(job, video, ctx, deps) : await runAnalysis(video, ctx);
  } catch (e) {
    const permanent = e instanceof NonRetryableError || isPermanentAiError(e);
    const finalAttempt = job.attempts >= job.maxAttempts;
    const message = safeMessage(e);
    if (permanent || finalAttempt) await markRunFailed(ctx, job, video, kind, message);
    throw permanent ? new NonRetryableError(message) : new Error(message);
  }
}

// ─── Veo ─────────────────────────────────────────────────────────────────────

async function currentGeneration(ctx: HandlerCtx, job: JobRow, videoId: string): Promise<GenerationRow | null> {
  const since = new Date((job.startedAt ?? new Date(0)).getTime() - 1_000);
  const [gen] = await ctx.db
    .select()
    .from(generations)
    .where(and(eq(generations.videoId, videoId), gte(generations.createdAt, since)))
    .orderBy(desc(generations.createdAt))
    .limit(1);
  return gen ?? null;
}

async function runVeo(job: JobRow, video: VideoRow, ctx: HandlerCtx, deps: GenerationDeps): Promise<JobResult> {
  const gen = await currentGeneration(ctx, job, video.id);
  if (!gen) return submitStep(video, ctx, deps);
  if (gen.status === "failed") throw new NonRetryableError(gen.error ?? "Generation failed");
  if (gen.status === "completed") return; // a previous attempt finished everything; nothing left to do
  return pollStep(job, video, gen, ctx, deps);
}

async function submitStep(video: VideoRow, ctx: HandlerCtx, deps: GenerationDeps): Promise<JobResult> {
  const { db } = ctx;
  const s = await loadSettings(db, video.userId);
  const cfg = video.aiConfig ?? {};
  // Same precedence as Convex: per-video config, then the user's defaults, then fixed defaults.
  const model = cfg.model ?? s?.veoModel ?? "veo-3.1-preview";
  const prompt = cfg.prompt ?? video.title;
  const resolution = cfg.resolution ?? s?.veoResolution ?? "720p";
  const aspectRatio = cfg.aspectRatio ?? s?.veoAspectRatio ?? "16:9";
  const durationSeconds = cfg.durationSeconds ?? s?.veoDurationSeconds ?? 8;
  const enhancePrompt = cfg.enhancePrompt ?? s?.veoEnhancePrompt ?? true;
  const numberOfVideos = cfg.numberOfVideos ?? s?.veoNumberOfVideos ?? 1;
  const generateAudio = cfg.generateAudio ?? true;

  // Gate the plan before spending anything.
  try {
    await consumeQuota(db, video.userId, "veoGenerated");
  } catch (e) {
    if (isPlanLimitError(e)) throw new NonRetryableError(VEO_LIMIT_MESSAGE);
    throw e;
  }

  const apiKey = await getPlatformKey(db, "gemini");
  let operationName: string;
  try {
    ({ operationName } = await deps.submitVeo(
      { model, prompt, negativePrompt: cfg.negativePrompt, resolution, aspectRatio, durationSeconds, enhancePrompt, numberOfVideos, generateAudio },
      apiKey,
    ));
  } catch (e) {
    await refundQuota(db, video.userId, "veoGenerated").catch(() => {});
    throw isPermanentAiError(e) ? new NonRetryableError(`Veo submission failed: ${safeMessage(e)}`) : new Error(`Veo submission failed: ${safeMessage(e)}`);
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(generations).values({
        userId: video.userId,
        videoId: video.id,
        model,
        prompt,
        negativePrompt: cfg.negativePrompt ?? null,
        resolution,
        aspectRatio,
        durationSeconds,
        generateAudio,
        status: "submitted",
        veoOperationName: operationName,
      });
      await tx
        .update(videos)
        .set({ veoOperationName: operationName, veoOperationDone: false, status: "generating", updatedAt: new Date() })
        .where(eq(videos.id, video.id));
    });
  } catch (e) {
    // The operation can no longer be tracked: give the unit back and let the retry resubmit.
    await refundQuota(db, video.userId, "veoGenerated").catch(() => {});
    throw e;
  }

  return { deferMs: POLL_DEFER_MS, metadata: { step: "poll", polls: 0, operationName } };
}

async function pollStep(job: JobRow, video: VideoRow, gen: GenerationRow, ctx: HandlerCtx, deps: GenerationDeps): Promise<JobResult> {
  const { db } = ctx;
  const operationName = gen.veoOperationName ?? video.veoOperationName;
  if (!operationName) throw new NonRetryableError("Video or Veo operation not found during polling");

  const prior = (job.metadata as { polls?: unknown } | null)?.polls;
  const polls = (typeof prior === "number" && Number.isFinite(prior) ? prior : 0) + 1;
  const apiKey = await getPlatformKey(db, "gemini");

  const result = await deps.pollVeo(operationName, apiKey);

  if (!result.done) {
    const elapsed = deps.now() - gen.createdAt.getTime();
    if (polls >= MAX_POLLS || elapsed >= MAX_GENERATION_MS) {
      throw new NonRetryableError(`Generation timed out after ${Math.round(Math.min(elapsed, MAX_GENERATION_MS) / 1000)}s`);
    }
    if (gen.status === "submitted") {
      await db.update(generations).set({ status: "processing", updatedAt: new Date() }).where(and(eq(generations.id, gen.id), eq(generations.status, "submitted")));
    }
    return { deferMs: POLL_DEFER_MS, metadata: { step: "poll", polls, operationName } };
  }

  return finalizeVeo(video, gen, result, apiKey, ctx, deps);
}

async function finalizeVeo(
  video: VideoRow,
  gen: GenerationRow,
  result: VeoOperationResult,
  apiKey: string | null,
  ctx: HandlerCtx,
  deps: GenerationDeps,
): Promise<JobResult> {
  const { db } = ctx;
  // Google deletes the output after ~2 days: copy it to Cloudinary right away.
  const publicId = `generated/${video.id}_${gen.id}`;
  const mimeType = result.videoMimeType ?? "video/mp4";
  let uploaded: CloudinaryUploadResult;
  if (result.videoUri) {
    if (!apiKey) throw new NonRetryableError("Gemini API key not configured: cannot download the Veo output");
    const res = await deps.downloadVeo(result.videoUri, apiKey);
    uploaded = await deps.uploadStream(res, publicId, mimeType);
  } else if (result.videoBytesBase64) {
    uploaded = await deps.uploadBytes(new Uint8Array(Buffer.from(result.videoBytesBase64, "base64")), publicId, mimeType);
  } else {
    throw new NonRetryableError("Veo returned no video data (no URI and no bytes)");
  }

  const poster = cloudinaryPosterUrl(uploaded.secureUrl);
  const generationTimeMs = Math.min(Math.max(deps.now() - gen.createdAt.getTime(), 0), 2_147_483_647);
  await db.transaction(async (tx) => {
    await tx
      .update(videos)
      .set({
        rawFileKey: uploaded.secureUrl,
        processedFileKey: uploaded.secureUrl,
        rawFileSize: uploaded.bytes,
        thumbnailUrl: poster,
        veoOperationDone: true,
        status: "ready",
        updatedAt: new Date(),
      })
      .where(eq(videos.id, video.id));
    await tx
      .update(generations)
      .set({ status: "completed", outputVideoUrl: uploaded.secureUrl, thumbnailUrl: poster, generationTimeMs, error: null, updatedAt: new Date() })
      .where(eq(generations.id, gen.id));
  });

  // From here on the video is ready: everything below is best effort and must not fail the job.
  const withMetadata = await metadataFromPrompt(ctx, video, gen.prompt);
  const title = withMetadata ?? video.aiTitle ?? video.title;
  try {
    await createNotification(db, {
      userId: video.userId,
      title: "Video generated",
      message: `"${title}" finished generating${withMetadata ? " and its metadata is ready" : ""}.`,
      type: "success",
      link: `/video/${video.id}`,
    });
  } catch (e) {
    console.error("[generation] createNotification failed:", safeMessage(e, 120));
  }
  // Closest event: the "metadata ready" toggle (AI work on a video finished); `kind` selects the wording.
  await sendUserNotification(db, video.userId, "metadataReady", { title, videoId: video.id, kind: "videoGenerated", withMetadata: !!withMetadata });
  return { metadata: { step: "done", generationId: gen.id, bytes: uploaded.bytes } };
}

/** Convex scheduled generateFromPrompt after Veo; skipped when the user turned auto-generate off. */
async function metadataFromPrompt(ctx: HandlerCtx, video: VideoRow, genPrompt: string): Promise<string | null> {
  const { db } = ctx;
  const prompt = video.aiConfig?.prompt ?? genPrompt;
  if (!prompt) return null;
  try {
    const s = await loadSettings(db, video.userId);
    if (s?.aiAutoGenerate === false) return null;
    try {
      await consumeQuota(db, video.userId, "metadataGenerated");
    } catch (e) {
      if (isPlanLimitError(e)) return null;
      throw e;
    }
    try {
      const meta = await generatePromptMetadata(db, video, prompt);
      await saveVideoMetadata(db, video.id, meta);
      return meta.title;
    } catch (e) {
      await refundQuota(db, video.userId, "metadataGenerated").catch(() => {});
      throw e;
    }
  } catch (e) {
    console.error("[generation] metadata from prompt failed:", safeMessage(e, 160));
    return null;
  }
}

// ─── uploaded video: Gemini metadata ─────────────────────────────────────────

async function runAnalysis(video: VideoRow, ctx: HandlerCtx): Promise<JobResult> {
  const { db } = ctx;
  if (!video.rawFileKey) throw new NonRetryableError("Video has no file to analyse");
  const meta = await generateVideoMetadata(db, video, { allowFilesApi: true, budgetMs: ANALYSIS_BUDGET_MS });
  await db.transaction(async (tx) => {
    await saveVideoMetadata(tx, video.id, meta);
    await tx.update(videos).set({ status: "ready", updatedAt: new Date() }).where(eq(videos.id, video.id));
  });
  await announceMetadata(db, video, meta.title, { ok: true });
  return { metadata: { step: "done" } };
}

// ─── failure bookkeeping ─────────────────────────────────────────────────────

/**
 * onJobFailed hook: records the failure when the handler's own bookkeeping never ran (a worker
 * that died on its last attempt and was given up on by stale recovery). A no-op when
 * runGenerationJob already marked the video failed, or the video moved on.
 */
export async function onGenerationJobFailed(job: JobRow, error: string, ctx: HandlerCtx): Promise<void> {
  const [video] = await ctx.db.select().from(videos).where(eq(videos.id, job.videoId)).limit(1);
  if (!video || !["generating", "queued", "draft"].includes(video.status)) return;
  await markRunFailed(ctx, job, video, video.sourceType === "generate" ? "veo" : "analysis", error);
}

async function markRunFailed(ctx: HandlerCtx, job: JobRow, video: VideoRow, kind: Kind, message: string): Promise<void> {
  const { db } = ctx;
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(videos)
        .set({ status: "failed", ...(kind === "veo" ? { veoOperationName: null, veoOperationDone: null } : {}), updatedAt: new Date() })
        .where(eq(videos.id, video.id));
      if (kind === "veo") {
        const since = new Date((job.startedAt ?? new Date(0)).getTime() - 1_000);
        await tx.execute(sql`
          update generations set status = 'failed', error = ${message}, updated_at = now()
          where id = (
            select id from generations
            where video_id = ${video.id} and created_at >= ${since.toISOString()}::timestamptz
            order by created_at desc limit 1
          )
        `);
      }
    });
  } catch (e) {
    console.error("[generation] could not record failure:", safeMessage(e, 120));
  }
  try {
    await createNotification(db, {
      userId: video.userId,
      title: kind === "veo" ? "Video generation failed" : "Metadata generation failed",
      message: `"${video.aiTitle ?? video.title}": ${safeMessage(message, 200)}`,
      type: "error",
      link: `/video/${video.id}`,
    });
  } catch (e) {
    console.error("[generation] createNotification failed:", safeMessage(e, 120));
  }
}
