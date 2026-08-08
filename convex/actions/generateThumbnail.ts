"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { GoogleGenAI } from "@google/genai";

// Cloudinary frame offsets to sample for best-frame selection
const FRAME_OFFSETS = ["so_5p", "so_20p", "so_40p", "so_60p", "so_80p"];

export const generate = action({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args): Promise<{ thumbnailUrl: string }> => {
    const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
    if (!video) throw new Error("Video not found");

    const platformSettings = await ctx.runQuery(internal.admin.platformSettings.getInternal);
    const geminiKey = platformSettings?.geminiApiKey ?? process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error("Gemini API key not configured.");

    const title = video.aiTitle ?? video.title;
    let thumbnailUrl: string;

    if (video.rawFileKey?.includes("res.cloudinary.com")) {
      // Use Gemini to pick the best frame from the video
      const ai = new GoogleGenAI({ apiKey: geminiKey });

      // Extract frame candidates
      const frameUrls = FRAME_OFFSETS.map((offset) =>
        video.rawFileKey
          .replace("/upload/", `/upload/${offset},w_640,h_360,c_fill/`)
          .replace(/\.(mp4|mov|avi|mkv|webm|flv|wmv)(\?.*)?$/, ".jpg")
      );

      const settled = await Promise.allSettled(
        frameUrls.map((url) =>
          fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .then((buf) => (buf ? Buffer.from(buf).toString("base64") : null))
        )
      );

      const frames = settled
        .map((r, i) => ({
          offset: FRAME_OFFSETS[i],
          base64: r.status === "fulfilled" ? r.value : null,
        }))
        .filter((f) => f.base64 !== null);

      let bestOffset = "so_25p";

      if (frames.length > 0) {
        // Ask Gemini which frame would make the best thumbnail
        const parts = frames.map((f) => ({
          inlineData: { data: f.base64!, mimeType: "image/jpeg" },
        }));
        parts.push({
          text: `These are ${frames.length} frames from a YouTube Short titled "${title}". ` +
            `Which frame index (0 to ${frames.length - 1}, zero-based) would make the most compelling YouTube thumbnail? ` +
            `Consider: clear subject, interesting composition, good lighting, and emotional impact. ` +
            `Reply with ONLY the index number (e.g. "2"), nothing else.`,
        } as any);

        try {
          const aiRes = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts }],
          });
          const text = (aiRes.text ?? "").trim();
          const idx = parseInt(text, 10);
          if (!isNaN(idx) && idx >= 0 && idx < frames.length) {
            bestOffset = frames[idx].offset;
          }
        } catch {
          // Fall back to 25% frame
        }
      }

      // Build high-quality Cloudinary thumbnail URL using the selected frame
      thumbnailUrl = video.rawFileKey
        .replace("/upload/", `/upload/${bestOffset},w_1280,h_720,c_fill,e_sharpen,e_vibrance:50/`)
        .replace(/\.(mp4|mov|avi|mkv|webm|flv|wmv)(\?.*)?$/, ".jpg");
    } else {
      throw new Error("Thumbnail generation requires a Cloudinary-hosted video.");
    }

    await ctx.runMutation(internal.videos.internalSetThumbnailGenerated, {
      id: args.videoId,
      thumbnailGeneratedUrl: thumbnailUrl,
    });

    return { thumbnailUrl };
  },
});
