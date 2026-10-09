// Port of convex/actions/metadata.ts. Export ONLY rpc definitions from this file.
//
// generateForUpload keeps the Convex arg/return shape ({ title, description, tags }). When the slow
// Gemini Files API would be needed (frame extraction unavailable) the work is handed to the
// `metadata.generate` task and the call returns at once with the current values plus `queued: true`.
// generateFromPrompt / bulkRegenerate were internal or unused by the UI and are not ported
// (prompt-based metadata runs inside the generation job; the UI loops generateForUpload itself).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { videos } from "@/db/schema";
import { cancelTask, enqueueTask } from "@/server/jobs/queue";
import { kickRunner } from "@/server/jobs/kick";
import { FramesUnavailableError, saveVideoMetadata } from "@/server/lib/ai/metadata";
import { GEMINI_NOT_CONFIGURED, GeminiNotConfiguredError, METADATA_LIMIT_MESSAGE, isPlanLimitError, publicError } from "@/server/lib/generation/common";
import { announceMetadata, clearMetadataSchedule, generateVideoMetadata, markReadyIfDraft, metadataTaskKey } from "@/server/lib/generation/metadataRuns";
import { getPlatformKey } from "@/server/lib/platformKeys";
import { consumeQuota, refundQuota } from "@/server/lib/usage";
import { action } from "../../rpc/define";
import { RpcError, badRequest, notFound } from "../../rpc/errors";

/** Inline budget: well inside the ~30s rpc action guideline (frames ~5-10s + one Gemini call). */
const INLINE_BUDGET_MS = 25_000;

export const generateForUpload = action({
  input: z.object({
    videoId: z.string().uuid(),
    autoMarkReady: z.boolean().optional(),
    humanize: z.boolean().optional(),
  }),
  handler: async (ctx, args): Promise<{ title: string; description: string; tags: string[]; queued?: true }> => {
    const { db, userId } = ctx;
    const [video] = await db
      .select()
      .from(videos)
      .where(and(eq(videos.id, args.videoId), eq(videos.userId, userId)))
      .limit(1);
    if (!video) throw notFound("Video not found");

    const hint = video.aiTitle ?? video.title;
    const current = { title: hint, description: video.aiDescription ?? "", tags: video.aiTags ?? [] };

    // Graceful skip: a scheduled-style run on a video that already moved past draft.
    if (args.autoMarkReady && video.status !== "draft") {
      await clearMetadataSchedule(db, video.id);
      return current;
    }

    // Configuration problems cost the user nothing: check before metering.
    if (!(await getPlatformKey(db, "gemini"))) throw badRequest(GEMINI_NOT_CONFIGURED);

    try {
      await consumeQuota(db, video.userId, "metadataGenerated");
    } catch (e) {
      if (isPlanLimitError(e)) {
        if (args.autoMarkReady) await clearMetadataSchedule(db, video.id);
        throw new RpcError("PLAN_LIMIT_EXCEEDED", METADATA_LIMIT_MESSAGE);
      }
      throw e;
    }

    try {
      const meta = await generateVideoMetadata(db, video, { humanize: args.humanize, allowFilesApi: false, budgetMs: INLINE_BUDGET_MS });
      await saveVideoMetadata(db, video.id, meta);
      // A manual or bulk regeneration makes any queued job redundant (it would overwrite these results).
      await clearMetadataSchedule(db, video.id);
      if (args.autoMarkReady) {
        await markReadyIfDraft(db, video.id);
        await announceMetadata(db, video, meta.title, { ok: true });
      }
      return { title: meta.title, description: meta.description, tags: meta.tags };
    } catch (e) {
      if (e instanceof FramesUnavailableError) {
        // Slow path: hand over to the background task (it keeps our metered unit across retries).
        await cancelTask(db, metadataTaskKey(video.id));
        const { created } = await enqueueTask(db, {
          kind: "metadata.generate",
          payload: { videoId: video.id, mode: "manual", quotaConsumed: true, humanize: args.humanize },
          userId: video.userId,
          dedupeKey: metadataTaskKey(video.id),
        });
        if (!created) await refundQuota(db, video.userId, "metadataGenerated").catch(() => {});
        else kickRunner();
        return { ...current, queued: true };
      }
      await refundQuota(db, video.userId, "metadataGenerated").catch(() => {});
      if (e instanceof GeminiNotConfiguredError) throw badRequest(GEMINI_NOT_CONFIGURED);
      throw publicError("Metadata generation failed", e);
    }
  },
});
