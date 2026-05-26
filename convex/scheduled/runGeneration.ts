"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { GoogleGenAI } from "@google/genai";

export const processGenerationJob = action({
  args: { jobId: v.id("jobs"), videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // 1. Mark job as processing
    await ctx.runMutation(internal.jobs.internalUpdateStatus, {
      id: args.jobId,
      status: "processing",
    });

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set in environment variables");
      }

      const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
      if (!video) throw new Error("Video not found");

      // 2. Fetch video from Cloudinary URL
      let videoUrl: string | null = null;
      if (video.rawFileKey.startsWith("http")) {
        videoUrl = video.rawFileKey;
      } else {
        videoUrl = await ctx.storage.getUrl(video.rawFileKey);
      }

      if (!videoUrl) throw new Error("Video URL not found");

      const response = await fetch(videoUrl);
      if (!response.ok) throw new Error(`Failed to fetch video: ${response.statusText}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString("base64");

      // 3. Send video inline to Gemini (avoids Files API videoDuration bug in SDK v2.6.0)
      const ai = new GoogleGenAI({ apiKey });

      const prompt = `Analyze this video and generate YouTube metadata. Return ONLY a raw JSON object with these keys:
- "title": A highly engaging YouTube title (max 60 characters).
- "description": A detailed, SEO-optimized YouTube description.
- "tags": An array of 5-10 SEO-optimized string tags.`;

      const aiResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "video/mp4", data: base64 } },
            { text: prompt },
          ],
        }],
        config: {
          responseMimeType: "application/json",
        },
      });

      const text = aiResponse.text || "";
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
        parsed = JSON.parse(cleaned);
      }

      // 4. Update the video with AI metadata
      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "ready",
      });

      await ctx.runMutation(internal.videos.internalUpdateMetadata, {
        id: args.videoId,
        aiTitle: parsed.title,
        aiDescription: parsed.description,
        aiTags: parsed.tags,
      });

      // 5. Mark job completed
      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "completed",
      });
    } catch (e: any) {
      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "failed",
        error: e.message,
      });

      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "failed",
      });
    }
  },
});
