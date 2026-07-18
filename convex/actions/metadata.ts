"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { createAiClient } from "../lib/ai";
import type { GoogleGenAI } from "@google/genai";

// ---------------------------------------------------------------------------
// Build content parts for video analysis.
// Cloudinary → 3 frame thumbnails (image tokens, ~$0.0004/video for 100 vids)
// Other      → Gemini Files API  (video tokens, ~$0.02-0.08/video)
// Both paths fall back gracefully so the handler always gets something.
// ---------------------------------------------------------------------------
async function buildVideoParts(
  ai: GoogleGenAI,
  videoUrl: string
): Promise<Array<Record<string, unknown>>> {
  if (videoUrl?.includes("res.cloudinary.com")) {
    // Extract frames at 0 s, 25 %, 75 % via Cloudinary URL transforms.
    // Each frame is ~300-500 image tokens — 3 frames ≈ 1,200 tokens total.
    const transforms = ["so_0", "so_25p", "so_75p"];
    const frameUrls = transforms.map(t =>
      videoUrl
        .replace("/upload/", `/upload/${t},w_640,h_360,c_fill/`)
        .replace(/\.(mp4|mov|avi|mkv|webm|flv|wmv)(\?.*)?$/, ".jpg")
    );

    const settled = await Promise.allSettled(
      frameUrls.map(url =>
        fetch(url)
          .then(r => (r.ok ? r.arrayBuffer() : null))
          .then(buf => (buf ? Buffer.from(buf).toString("base64") : null))
      )
    );

    const parts = settled
      .filter(
        (r): r is PromiseFulfilledResult<string> =>
          r.status === "fulfilled" && typeof r.value === "string"
      )
      .map(r => ({ inlineData: { data: r.value, mimeType: "image/jpeg" } }));

    if (parts.length > 0) return parts;
    // All frame fetches returned null — fall through to Files API (50-200× cost increase)
    console.warn(`[buildVideoParts] Cloudinary frame extraction failed, falling through to Files API`);
  }

  // Files API path: works for any publicly accessible HTTPS URL.
  // The file is automatically deleted by Google after 48 hours.
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Could not fetch video for analysis: ${res.status}`);

  const blob = await res.blob();
  const mimeType =
    blob.type && blob.type !== "application/octet-stream" ? blob.type : "video/mp4";

  let file = await (ai as any).files.upload({
    file: blob,
    config: { mimeType, displayName: "video" },
  });

  // Poll until Gemini finishes processing (up to 2 minutes)
  for (let i = 0; i < 60 && file?.state === "PROCESSING"; i++) {
    await new Promise(r => setTimeout(r, 2000));
    file = await (ai as any).files.get({ name: file.name });
  }

  if (file?.state === "FAILED") throw new Error("Gemini file processing failed.");

  return [{ fileData: { fileUri: file.uri, mimeType } }];
}

export const generateFromPrompt = action({
  args: {
    videoId: v.id("videos"),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(`[generateFromPrompt] Starting — videoId=${args.videoId} prompt="${args.prompt.slice(0, 80)}"`);

    let ai;
    try {
      ({ ai } = createAiClient());
    } catch (err) {
      console.error("[generateFromPrompt] No AI credentials available — skipping metadata generation:", err);
      return;
    }

    try {
      console.log("[generateFromPrompt] Calling gemini-2.5-flash for metadata...");
      const aiResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{
          role: "user",
          parts: [{
            text: `Based on this video generation prompt, create YouTube metadata. Return ONLY a raw JSON object with these exact keys:
- "title": A highly engaging YouTube title (max 60 characters)
- "description": A detailed, SEO-optimized YouTube description (2-3 paragraphs)
- "tags": An array of 5-10 SEO-optimized string tags

Prompt: "${args.prompt}"`,
          }],
        }],
        config: { responseMimeType: "application/json" },
      });

      const text = aiResponse.text ?? "";
      console.log(`[generateFromPrompt] Response — "${text.slice(0, 200)}"`);

      let parsed: { title?: string; description?: string; tags?: string[] };
      try {
        parsed = JSON.parse(text);
      } catch {
        const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        parsed = JSON.parse(cleaned);
      }

      console.log(`[generateFromPrompt] Parsed — title="${parsed.title}" tags=${JSON.stringify(parsed.tags)}`);

      await ctx.runMutation(internal.videos.internalUpdateMetadata, {
        id: args.videoId,
        aiTitle: parsed.title,
        aiDescription: parsed.description,
        aiTags: parsed.tags,
      });

      console.log("[generateFromPrompt] Metadata saved successfully");
    } catch (err) {
      console.error("[generateFromPrompt] FAILED:", err instanceof Error ? err.message : err);
      if (err instanceof Error && err.stack) console.error(err.stack);
    }
  },
});

export const generateForUpload = action({
  args: {
    videoId: v.id("videos"),
    autoMarkReady: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ title: string; description: string; tags: string[] }> => {
    const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });

    // Video was deleted since scheduling — skip gracefully for scheduled runs
    if (!video) {
      if (args.autoMarkReady) return { title: "", description: "", tags: [] };
      throw new Error("Video not found");
    }

    // Graceful skip — video was already processed since scheduling
    if (args.autoMarkReady && video.status !== "draft") {
      await ctx.runMutation(internal.videos.internalClearMetadataSchedule, { id: args.videoId });
      return {
        title: video.aiTitle ?? video.title,
        description: video.aiDescription ?? "",
        tags: video.aiTags ?? [],
      };
    }

    const hint = (video as any).aiTitle ?? video.title;

    let ai;
    try {
      ({ ai } = createAiClient());
    } catch {
      if (args.autoMarkReady) {
        await ctx.runMutation(internal.videos.internalClearMetadataSchedule, { id: args.videoId });
        await ctx.runAction(api.actions.telegram.sendNotification, {
          userId: video.userId,
          message: `❌ Metadata failed: "${hint}" — AI credentials not configured. Video remains as draft.`,
        });
      }
      throw new Error("AI credentials not configured on server.");
    }

    try {
      // Build vision parts — frames (Cloudinary) or Files API (R2/other)
      const videoParts = await buildVideoParts(ai, video.rawFileKey);

      const aiResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{
          role: "user",
          parts: [
            ...videoParts,
            {
              text: `This is a motivational YouTube Short (vertical, under 60 seconds). Its filename or working title is: "${hint}".

Analyze what is actually shown and said:
• Read any text overlays, quotes, or captions word-for-word
• Identify the speaker or person quoted if visible
• Capture the single core motivational message

Return ONLY a JSON object:
{
  "title": "<hook-style title that teases the message, max 50 chars, no hashtags>",
  "description": "<one punchy sentence summarising the message, then a second sentence with a call to action — 2 sentences max, no hashtags in description>",
  "tags": ["shorts", "motivation", "motivationalvideo", "<topic-specific tag>", "<emotion tag e.g. mindset/success/confidence>", "<speaker name or quote keyword if identifiable>", "<niche tag e.g. selfimprovement/hustle/faith>", "viral"]
}`,
            },
          ],
        }],
        config: { responseMimeType: "application/json" },
      });

      const text = aiResponse.text ?? "";
      let parsed: { title?: string; description?: string; tags?: string[] };
      try {
        parsed = JSON.parse(text);
      } catch {
        const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        parsed = JSON.parse(cleaned);
      }

      await ctx.runMutation(internal.videos.internalUpdateMetadata, {
        id: args.videoId,
        aiTitle: parsed.title,
        aiDescription: parsed.description,
        aiTags: parsed.tags,
      });

      if (args.autoMarkReady) {
        await ctx.runMutation(internal.videos.internalUpdateStatus, { id: args.videoId, status: "ready" });
        await ctx.runMutation(internal.videos.internalClearMetadataSchedule, { id: args.videoId });
        await ctx.runAction(api.actions.telegram.sendNotification, {
          userId: video.userId,
          message: `✅ Metadata ready: "${parsed.title ?? hint}" is now ready for YouTube publishing.`,
        }).catch(() => {});
      }

      return {
        title: parsed.title ?? hint,
        description: parsed.description ?? "",
        tags: parsed.tags ?? [],
      };
    } catch (err) {
      if (args.autoMarkReady) {
        await ctx.runMutation(internal.videos.internalClearMetadataSchedule, { id: args.videoId });
        await ctx.runAction(api.actions.telegram.sendNotification, {
          userId: video.userId,
          message: `❌ Metadata failed: "${hint}" — ${err instanceof Error ? err.message : "Unknown error"}. Video remains as draft.`,
        }).catch(() => {});
      }
      throw err;
    }
  },
});
