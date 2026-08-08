"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { submitVeoGeneration } from "../lib/ai";

export const startVeoGeneration = action({
  args: {
    videoId: v.id("videos"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    console.log(`[startVeoGeneration] Starting — videoId=${args.videoId} jobId=${args.jobId}`);

    const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
    if (!video) {
      console.error(`[startVeoGeneration] Video not found: ${args.videoId}`);
      throw new Error("Video not found");
    }

    // Enforce plan gate before spending any API quota
    await ctx.runMutation(internal.usageLedger.internalConsumeQuota, {
      userId: video.userId,
      field: "veoGenerated",
    });

    const settings = await ctx.runQuery(internal.settings.getByVideoUserId, { userId: video.userId });

    const aiConfig = video.aiConfig ?? {};
    // Default to veo-3.1-preview — latest with audio support
    const model           = aiConfig.model           ?? settings?.veoModel           ?? "veo-3.1-preview";
    const prompt          = aiConfig.prompt          ?? video.title;
    const resolution      = aiConfig.resolution      ?? settings?.veoResolution      ?? "720p";
    const aspectRatio     = aiConfig.aspectRatio     ?? settings?.veoAspectRatio     ?? "16:9";
    const durationSeconds = aiConfig.durationSeconds ?? settings?.veoDurationSeconds ?? 8;
    const enhancePrompt   = aiConfig.enhancePrompt   ?? settings?.veoEnhancePrompt   ?? true;
    const numberOfVideos  = aiConfig.numberOfVideos  ?? settings?.veoNumberOfVideos  ?? 1;
    // generateAudio is passed through; submitVeoGeneration gates it to Vertex AI models only
    const generateAudio   = aiConfig.generateAudio   ?? true;
    console.log(`[startVeoGeneration] Config — model=${model} resolution=${resolution} aspectRatio=${aspectRatio} duration=${durationSeconds}s generateAudio=${generateAudio}`);
    console.log(`[startVeoGeneration] Prompt — "${prompt.slice(0, 120)}"`);

    if (!process.env.GEMINI_API_KEY) {
      console.error("[startVeoGeneration] GEMINI_API_KEY is not set in Convex env");
    }

    try {
      console.log(`[startVeoGeneration] Submitting to Veo API...`);
      const result = await submitVeoGeneration({
        model, prompt, negativePrompt: aiConfig.negativePrompt,
        resolution, aspectRatio, durationSeconds, enhancePrompt, numberOfVideos, generateAudio,
      });
      console.log(`[startVeoGeneration] Veo operation created — operationName=${result.operationName}`);

      await ctx.runMutation(internal.videos.internalUpdateVeoOperation, {
        id: args.videoId,
        veoOperationName: result.operationName,
        veoOperationDone: false,
      });
      await ctx.runMutation(internal.videos.internalUpdateStatus, { id: args.videoId, status: "generating" });
      await ctx.runMutation(internal.jobs.internalUpdateStatus, { id: args.jobId, status: "processing" });
      await ctx.runMutation(internal.generations.internalCreate, {
        userId: video.userId, videoId: args.videoId, model, prompt,
        negativePrompt: aiConfig.negativePrompt, resolution, aspectRatio,
        durationSeconds, generateAudio, veoOperationName: result.operationName,
      });

      console.log(`[startVeoGeneration] Scheduling first poll in 15s`);
      await ctx.scheduler.runAfter(15_000, api.scheduled.runGeneration.pollVeo, {
        jobId: args.jobId, videoId: args.videoId, attempt: 1, maxAttempts: 40,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[startVeoGeneration] FAILED — ${message}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId, status: "failed", error: `Veo submission failed: ${message}`,
      });
      await ctx.runMutation(internal.videos.internalUpdateStatus, { id: args.videoId, status: "failed" });
    }
  },
});
