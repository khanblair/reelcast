"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { createAiClient } from "../lib/ai";
import { GoogleGenAI } from "@google/genai";

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

    const platformSettings = await ctx.runQuery(internal.admin.platformSettings.getInternal);
    const geminiKey = platformSettings?.geminiApiKey ?? process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      console.error("[generateFromPrompt] No Gemini API key — set it in Admin > Settings or GEMINI_API_KEY env var.");
      return;
    }
    const ai = new GoogleGenAI({ apiKey: geminiKey });

    try {
      console.log("[generateFromPrompt] Calling gemini-2.5-flash for metadata...");
      const aiResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{
          role: "user",
          parts: [{
            text: `You are a YouTube Shorts metadata specialist with deep knowledge of YouTube SEO and the VidIQ ranking methodology.

A YouTube Short is being generated from this AI prompt: "${args.prompt}"

Return ONLY this JSON — no markdown, no explanation:
{
  "title": "...",
  "description": "...",
  "tags": [...]
}

TITLE (max 55 chars): Write a curiosity-gap or emotional-tension hook. Use patterns like "Why [unexpected claim]", "The Truth About [topic]", "Stop [common action] — Here's Why". Include the specific topic keyword. No hashtags, no ALL CAPS.

DESCRIPTION: Line 1 (100 chars, search snippet): punchy expansion of the title hook. Line 2: what the viewer gains. Line 3: call to action (e.g. "Follow for daily drops"). Line 4: hashtags — always start with #Shorts then 3-4 niche tags.

TAGS (12-15, VidIQ tiered): 2 broad ("shorts" + one category), 3-4 medium niche, 5-6 specific to this video's topic/emotion/scenario, 2-3 long-tail phrase tags people actually search. Never use "viral", "trending", "fyp", "motivationalvideo".`,
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

    const platformSettings = await ctx.runQuery(internal.admin.platformSettings.getInternal);
    const geminiKey = platformSettings?.geminiApiKey ?? process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      if (args.autoMarkReady) {
        await ctx.runMutation(internal.videos.internalClearMetadataSchedule, { id: args.videoId });
        await ctx.runAction(api.actions.telegram.sendNotification, {
          userId: video.userId,
          message: `❌ Metadata failed: "${hint}" — Gemini API key not configured. Set it in Admin > Settings.`,
        });
      }
      throw new Error("Gemini API key not configured. Set it in Admin > Settings or GEMINI_API_KEY env var.");
    }
    const ai = new GoogleGenAI({ apiKey: geminiKey });

    try {
      // Build vision parts — frames (Cloudinary) or Files API (R2/other)
      const videoParts = await buildVideoParts(ai, video.rawFileKey);

      // Fetch user settings to personalise the prompt
      const userSettings = await ctx.runQuery(internal.settings.getByVideoUserId, { userId: video.userId });
      const guidelines = userSettings?.aiGuidelines as string | undefined;
      const tone       = userSettings?.aiTone       as string | undefined;

      const aiResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{
          role: "user",
          parts: [
            ...videoParts,
            {
              text: `You are a YouTube Shorts metadata specialist with deep knowledge of YouTube SEO and the VidIQ ranking methodology.

This is a YouTube Short (vertical video, under 60 seconds). Working title: "${hint}".${guidelines ? `\nChannel guidelines: ${guidelines}` : ""}${tone ? `\nContent tone: ${tone}` : ""}

Analyze the video frames provided:
• Read ALL text overlays, quotes, and captions word-for-word
• Identify the speaker or person quoted if visible
• Capture the single core message or emotional insight

Return ONLY this JSON — no markdown, no explanation:
{
  "title": "...",
  "description": "...",
  "tags": [...]
}

═══ TITLE ═══ (max 55 chars — strict)
Write a curiosity-gap or emotional-tension hook that makes viewers NEED to watch.
Winning patterns:
  • "Why [unexpected claim about common belief]"
  • "The [number] [topic] Nobody Talks About"
  • "Stop [common action] — Here's Why"
  • "[Surprising emotional statement]"
  • "The Truth About [relatable struggle]"
Rules:
  ✓ Include the specific topic keyword (what the video is actually about)
  ✓ Create an open loop — viewer must watch to close it
  ✓ Use strong, concrete words — NOT "amazing", "inspiring", "motivational"
  ✗ No hashtags in the title. No ellipsis. No ALL CAPS.

═══ DESCRIPTION ═══
Line 1 (first 100 chars = YouTube search snippet): one specific, punchy statement expanding the title hook with a concrete detail from the video.
Line 2: What the viewer will feel, learn, or realise from watching.
Line 3: Call to action — e.g. "Follow for daily drops" or "Share this with someone who needs to hear it today."
Line 4: Hashtags on their own line — ALWAYS start with #Shorts, then 3-4 topic/niche hashtags (e.g. #Shorts #Mindset #SelfImprovement #Faith).
#Shorts is MANDATORY — the YouTube algorithm uses it to classify Shorts correctly.

═══ TAGS ═══ (12-15 tags total, tiered by competition — VidIQ methodology)
Tier 1 — Broad, high-volume (2 tags): "shorts", and ONE other broad category word
Tier 2 — Medium competition (3-4 tags): niche words like "selfimprovement", "mindset", "success", "inspiration", "faith"
Tier 3 — Specific to THIS video (5-6 tags): the exact topic, speaker name or quote keyword, the core emotion, the situation or scenario described in the video
Tier 4 — Long-tail phrase tags (2-3 tags): 3-5 word phrases people actually search (e.g. "morning motivation shorts 2026", "faith over fear quotes", "mindset shift for success")
NEVER include: "viral", "trending", "fyp", "foryoupage", "motivationalvideo" — YouTube ignores these and they dilute relevance.`,
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

      // Always clear any pending metadata schedule — a manual or bulk regeneration makes
      // the queued job redundant, and leaving it alive would overwrite these fresh results.
      await ctx.runMutation(internal.videos.internalClearMetadataSchedule, { id: args.videoId });

      if (args.autoMarkReady) {
        await ctx.runMutation(internal.videos.internalUpdateStatus, { id: args.videoId, status: "ready" });
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
      await ctx.runMutation(internal.videos.internalClearMetadataSchedule, { id: args.videoId });
      if (args.autoMarkReady) {
        await ctx.runAction(api.actions.telegram.sendNotification, {
          userId: video.userId,
          message: `❌ Metadata failed: "${hint}" — ${err instanceof Error ? err.message : "Unknown error"}. Video remains as draft.`,
        }).catch(() => {});
      }
      throw err;
    }
  },
});

// ---------------------------------------------------------------------------
// Bulk regenerate metadata for a list of videos immediately (no scheduling).
// Processes sequentially with a short delay to respect Gemini rate limits.
// Works for any video status (draft, ready, etc.).
// ---------------------------------------------------------------------------
export const bulkRegenerate = action({
  args: {
    videoIds: v.array(v.id("videos")),
  },
  handler: async (ctx, args): Promise<{ videoId: string; success: boolean; title?: string; error?: string }[]> => {
    const results: { videoId: string; success: boolean; title?: string; error?: string }[] = [];

    for (const videoId of args.videoIds) {
      try {
        const result = await ctx.runAction(api.actions.metadata.generateForUpload, {
          videoId,
          autoMarkReady: false,
        });
        results.push({ videoId, success: true, title: result.title });
      } catch (err) {
        results.push({
          videoId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Brief pause between videos to avoid Gemini rate limits
      if (args.videoIds.indexOf(videoId) < args.videoIds.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    return results;
  },
});
