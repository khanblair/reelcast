"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { GoogleGenAI } from "@google/genai";

export const generateFromPrompt = action({
  args: {
    videoId: v.id("videos"),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(`[generateFromPrompt] Starting — videoId=${args.videoId} prompt="${args.prompt.slice(0, 80)}"`);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[generateFromPrompt] GEMINI_API_KEY not set — skipping metadata generation");
      return;
    }

    const ai = new GoogleGenAI({ apiKey });

    try {
      console.log("[generateFromPrompt] Calling Gemini gemini-2.5-flash...");
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
      console.log(`[generateFromPrompt] Gemini response — "${text.slice(0, 200)}"`);

      let parsed: { title?: string; description?: string; tags?: string[] };
      try {
        parsed = JSON.parse(text);
      } catch {
        const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        console.log(`[generateFromPrompt] Retrying parse after strip — "${cleaned.slice(0, 100)}"`);
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
