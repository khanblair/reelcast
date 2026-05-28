"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { GoogleGenAI } from "@google/genai";
import { pollVeoOperation, uploadVideoBytesToCloudinary } from "../lib/ai";

// Max inline video size to send to Gemini — anything larger uses the Files API
const MAX_INLINE_BYTES = 15 * 1024 * 1024; // 15 MB

export const processGenerationJob = action({
  args: { jobId: v.id("jobs"), videoId: v.id("videos") },
  handler: async (ctx, args) => {
    console.log(`[processGenerationJob] Starting — videoId=${args.videoId} jobId=${args.jobId}`);

    await ctx.runMutation(internal.jobs.internalUpdateStatus, {
      id: args.jobId,
      status: "processing",
    });

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set in Convex env");

      const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
      if (!video) throw new Error("Video not found");
      console.log(`[processGenerationJob] Video found — title="${video.title}" size=${video.rawFileSize}B`);

      // Resolve URL
      let videoUrl: string | null = null;
      if (video.rawFileKey.startsWith("http")) {
        videoUrl = video.rawFileKey;
      } else {
        videoUrl = await ctx.storage.getUrl(video.rawFileKey);
      }
      if (!videoUrl) throw new Error("Could not resolve video URL");
      console.log(`[processGenerationJob] Video URL resolved — ${videoUrl.slice(0, 80)}...`);

      const ai = new GoogleGenAI({ apiKey });

      const metaPrompt = `Analyze this video and generate YouTube metadata. Return ONLY a raw JSON object with these exact keys:
- "title": A highly engaging YouTube title (max 60 characters).
- "description": A detailed, SEO-optimized YouTube description (2-3 paragraphs).
- "tags": An array of 5-10 SEO-optimized string tags.`;

      let aiResponse;

      if (video.rawFileSize && video.rawFileSize > MAX_INLINE_BYTES) {
        // Large file — use Gemini Files API
        console.log(`[processGenerationJob] File is ${(video.rawFileSize / 1024 / 1024).toFixed(1)}MB — using Files API`);

        const fetchRes = await fetch(videoUrl);
        if (!fetchRes.ok) throw new Error(`Failed to fetch video: ${fetchRes.status} ${fetchRes.statusText}`);
        const buffer = Buffer.from(await fetchRes.arrayBuffer());
        console.log(`[processGenerationJob] Downloaded ${buffer.byteLength} bytes, uploading to Files API...`);

        const blob = new Blob([buffer], { type: "video/mp4" });
        const uploadedFile = await ai.files.upload({
          file: blob,
          config: { mimeType: "video/mp4", displayName: video.title },
        });
        console.log(`[processGenerationJob] Files API upload complete — uri=${uploadedFile.uri} state=${uploadedFile.state}`);

        // Wait for file to be active
        let file = uploadedFile;
        let waitMs = 0;
        while (file.state === "PROCESSING" && waitMs < 60_000) {
          await new Promise((r) => setTimeout(r, 3000));
          waitMs += 3000;
          file = await ai.files.get({ name: file.name! });
          console.log(`[processGenerationJob] File state=${file.state} (waited ${waitMs}ms)`);
        }
        if (file.state !== "ACTIVE") {
          throw new Error(`File not ready after wait — state=${file.state}`);
        }

        aiResponse = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{
            role: "user",
            parts: [
              { fileData: { mimeType: "video/mp4", fileUri: file.uri! } },
              { text: metaPrompt },
            ],
          }],
          config: { responseMimeType: "application/json" },
        });
      } else {
        // Small file — inline base64
        console.log(`[processGenerationJob] File is small — using inline base64`);
        const fetchRes = await fetch(videoUrl);
        if (!fetchRes.ok) throw new Error(`Failed to fetch video: ${fetchRes.status} ${fetchRes.statusText}`);
        const buffer = Buffer.from(await fetchRes.arrayBuffer());
        const base64 = buffer.toString("base64");
        console.log(`[processGenerationJob] Sending ${buffer.byteLength} bytes (base64) to Gemini`);

        aiResponse = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{
            role: "user",
            parts: [
              { inlineData: { mimeType: "video/mp4", data: base64 } },
              { text: metaPrompt },
            ],
          }],
          config: { responseMimeType: "application/json" },
        });
      }

      const text = aiResponse.text ?? "";
      console.log(`[processGenerationJob] Gemini response received — ${text.slice(0, 200)}`);

      let parsed: { title?: string; description?: string; tags?: string[] };
      try {
        parsed = JSON.parse(text);
      } catch {
        const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        console.log(`[processGenerationJob] JSON parse failed, retrying after strip — "${cleaned.slice(0, 100)}"`);
        parsed = JSON.parse(cleaned);
      }

      console.log(`[processGenerationJob] Metadata parsed — title="${parsed.title}" tags=${JSON.stringify(parsed.tags)}`);

      await ctx.runMutation(internal.videos.internalUpdateStatus, { id: args.videoId, status: "ready" });
      await ctx.runMutation(internal.videos.internalUpdateMetadata, {
        id: args.videoId,
        aiTitle: parsed.title,
        aiDescription: parsed.description,
        aiTags: parsed.tags,
      });
      await ctx.runMutation(internal.jobs.internalUpdateStatus, { id: args.jobId, status: "completed" });
      console.log(`[processGenerationJob] Done — video marked ready`);

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[processGenerationJob] FAILED — ${message}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      await ctx.runMutation(internal.jobs.internalUpdateStatus, { id: args.jobId, status: "failed", error: message });
      await ctx.runMutation(internal.videos.internalUpdateStatus, { id: args.videoId, status: "failed" });
    }
  },
});

export const pollVeo = action({
  args: {
    jobId: v.id("jobs"),
    videoId: v.id("videos"),
    attempt: v.number(),
    maxAttempts: v.number(),
  },
  handler: async (ctx, args) => {
    console.log(`[pollVeo] Polling attempt ${args.attempt}/${args.maxAttempts} — videoId=${args.videoId}`);

    const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
    if (!video || !video.veoOperationName) {
      const msg = "Video or Veo operation not found during polling";
      console.error(`[pollVeo] ${msg}`);
      await ctx.runMutation(internal.jobs.internalUpdateStatus, { id: args.jobId, status: "failed", error: msg });
      await ctx.runMutation(internal.generations.internalUpdateStatus, { videoId: args.videoId, status: "failed", error: msg });
      return;
    }

    console.log(`[pollVeo] operationName=${video.veoOperationName}`);

    try {
      const result = await pollVeoOperation(video.veoOperationName);
      console.log(`[pollVeo] Poll result — done=${result.done} hasUri=${!!result.videoUri} hasBytes=${!!result.videoBytesBase64}`);

      if (!result.done) {
        if (args.attempt >= args.maxAttempts) {
          throw new Error(`Generation timed out after ${args.maxAttempts * 15}s`);
        }
        await ctx.runMutation(internal.generations.internalUpdateStatus, { videoId: args.videoId, status: "processing" });
        console.log(`[pollVeo] Not done — scheduling next poll in 15s (attempt ${args.attempt + 1})`);
        await ctx.scheduler.runAfter(15_000, api.scheduled.runGeneration.pollVeo, {
          jobId: args.jobId, videoId: args.videoId,
          attempt: args.attempt + 1, maxAttempts: args.maxAttempts,
        });
        return;
      }

      console.log(`[pollVeo] Generation complete — processing output`);
      const generationTimeMs = Date.now() - video._creationTime;
      let processedFileKey: string;

      if (result.videoUri) {
        // Google Files API URIs require an API key — they're not publicly accessible.
        // Download the video server-side and upload to Cloudinary so it can be played.
        console.log(`[pollVeo] Got videoUri (full): ${result.videoUri}`);
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY not set — cannot download Veo output");

        // Google Files API media-download pattern: append `:download` to the resource
        // path then add ?alt=media&key=... — plain ?alt=media without :download returns 400.
        // URI format: https://generativelanguage.googleapis.com/v1beta/files/{id}
        // Download:   https://generativelanguage.googleapis.com/v1beta/files/{id}:download?alt=media
        const downloadUrl = new URL(result.videoUri + ":download");
        downloadUrl.searchParams.set("alt", "media");
        downloadUrl.searchParams.set("key", apiKey);
        console.log(`[pollVeo] Download URL: ${downloadUrl.toString().replace(apiKey, "***")}`);

        let videoRes = await fetch(downloadUrl.toString());

        // Fallback: try without :download suffix (some URI variants don't need it)
        if (!videoRes.ok) {
          console.log(`[pollVeo] :download fetch failed (${videoRes.status}) — retrying plain alt=media`);
          const fallbackUrl = new URL(result.videoUri);
          fallbackUrl.searchParams.set("alt", "media");
          fallbackUrl.searchParams.set("key", apiKey);
          videoRes = await fetch(fallbackUrl.toString());
        }

        if (!videoRes.ok) {
          const body = await videoRes.text();
          throw new Error(`Failed to download Veo video: ${videoRes.status} ${videoRes.statusText} — ${body.slice(0, 200)}`);
        }

        const buffer = Buffer.from(await videoRes.arrayBuffer());
        console.log(`[pollVeo] Downloaded ${buffer.byteLength} bytes — uploading to Cloudinary...`);
        const base64 = buffer.toString("base64");
        const uploadResult = await uploadVideoBytesToCloudinary(
          base64,
          result.videoMimeType ?? "video/mp4",
          args.videoId
        );
        processedFileKey = uploadResult.secure_url;
        console.log(`[pollVeo] Cloudinary upload complete — ${processedFileKey}`);
      } else if (result.videoBytesBase64) {
        console.log(`[pollVeo] Got video bytes — uploading to Cloudinary...`);
        const uploadResult = await uploadVideoBytesToCloudinary(
          result.videoBytesBase64,
          result.videoMimeType ?? "video/mp4",
          args.videoId
        );
        processedFileKey = uploadResult.secure_url;
        console.log(`[pollVeo] Cloudinary upload complete — ${processedFileKey}`);
      } else {
        throw new Error("Veo returned no video data (no URI and no bytes)");
      }

      await ctx.runMutation(internal.videos.internalUpdateProcessedFile, {
        id: args.videoId, processedFileKey, veoOperationDone: true,
      });
      await ctx.runMutation(internal.videos.internalUpdateStatus, { id: args.videoId, status: "ready" });
      await ctx.runMutation(internal.jobs.internalUpdateStatus, { id: args.jobId, status: "completed" });
      await ctx.runMutation(internal.generations.internalUpdateStatus, {
        videoId: args.videoId, status: "completed",
        outputVideoUrl: processedFileKey, generationTimeMs,
      });

      console.log(`[pollVeo] Video ready — generationTime=${(generationTimeMs / 1000).toFixed(1)}s`);

      // Kick off metadata generation from the prompt
      if (video.aiConfig?.prompt) {
        console.log(`[pollVeo] Scheduling metadata generation from prompt`);
        await ctx.scheduler.runAfter(0, api.actions.metadata.generateFromPrompt, {
          videoId: args.videoId, prompt: video.aiConfig.prompt,
        });
      }

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pollVeo] FAILED on attempt ${args.attempt} — ${message}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      await ctx.runMutation(internal.jobs.internalUpdateStatus, { id: args.jobId, status: "failed", error: message });
      await ctx.runMutation(internal.videos.internalUpdateStatus, { id: args.videoId, status: "failed" });
      await ctx.runMutation(internal.generations.internalUpdateStatus, { videoId: args.videoId, status: "failed", error: message });
    }
  },
});
