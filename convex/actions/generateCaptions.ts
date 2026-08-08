"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { GoogleGenAI } from "@google/genai";

// Generate a WebVTT caption file for a video using Gemini transcription.
// For Cloudinary-hosted videos we send frames + ask for timestamped transcript.
// For other sources we use the Gemini Files API.
export const generate = action({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args): Promise<{ captionsVtt: string }> => {
    const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
    if (!video) throw new Error("Video not found");

    const platformSettings = await ctx.runQuery(internal.admin.platformSettings.getInternal);
    const geminiKey = platformSettings?.geminiApiKey ?? process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error("Gemini API key not configured.");

    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const duration = video.duration ?? 60;

    let parts: Array<Record<string, unknown>>;

    if (video.rawFileKey?.includes("res.cloudinary.com")) {
      // Sample frames across the video for transcript estimation
      const numSamples = Math.min(10, Math.ceil(duration / 6));
      const offsets = Array.from({ length: numSamples }, (_, i) =>
        `so_${Math.round((i / (numSamples - 1)) * 100)}p`
      );

      const settled = await Promise.allSettled(
        offsets.map((offset) => {
          const url = video.rawFileKey
            .replace("/upload/", `/upload/${offset},w_640,h_360,c_fill/`)
            .replace(/\.(mp4|mov|avi|mkv|webm|flv|wmv)(\?.*)?$/, ".jpg");
          return fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .then((buf) => (buf ? Buffer.from(buf).toString("base64") : null));
        })
      );

      const frames = settled
        .map((r, i) => ({
          offset: offsets[i],
          pct: Math.round((i / (numSamples - 1)) * 100),
          base64: r.status === "fulfilled" ? r.value : null,
        }))
        .filter((f) => f.base64 !== null);

      parts = [
        ...frames.map((f) => ({
          inlineData: { data: f.base64!, mimeType: "image/jpeg" },
        })),
        {
          text:
            `These are ${frames.length} frames evenly sampled from a ${duration}-second video titled "${video.aiTitle ?? video.title}". ` +
            `Each frame represents approximately ${Math.round(duration / frames.length)} seconds of video. ` +
            `Read all visible text (on-screen captions, quotes, graphics) and infer spoken content from the visual context. ` +
            `Generate a transcript with approximate timestamps in WebVTT format. ` +
            `Use the frame sequence to estimate when text appears and disappears. ` +
            `Return ONLY valid WebVTT content starting with "WEBVTT", nothing else. Example format:\n\nWEBVTT\n\n00:00:00.000 --> 00:00:03.000\nFirst line of spoken or on-screen text`,
        },
      ];
    } else {
      // Gemini Files API — send actual video
      const res = await fetch(video.rawFileKey);
      if (!res.ok) throw new Error(`Could not fetch video: ${res.status}`);
      const blob = await res.blob();
      const mimeType = blob.type || "video/mp4";

      let file = await (ai as any).files.upload({
        file: blob,
        config: { mimeType, displayName: "video" },
      });
      for (let i = 0; i < 60 && file?.state === "PROCESSING"; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        file = await (ai as any).files.get({ name: file.name });
      }
      if (file?.state === "FAILED") throw new Error("Gemini file processing failed.");

      parts = [
        { fileData: { fileUri: file.uri, mimeType } },
        {
          text:
            `Transcribe this video with accurate timestamps. ` +
            `Return ONLY valid WebVTT content starting with "WEBVTT", nothing else.`,
        },
      ];
    }

    const aiRes = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts }],
    });

    let captionsVtt = aiRes.text ?? "";

    // Clean up any markdown fences
    captionsVtt = captionsVtt.replace(/```[a-z]*\n?/g, "").replace(/```\n?/g, "").trim();
    if (!captionsVtt.startsWith("WEBVTT")) {
      captionsVtt = "WEBVTT\n\n" + captionsVtt;
    }

    await ctx.runMutation(internal.videos.internalSetCaptionsVtt, {
      id: args.videoId,
      captionsVtt,
    });

    return { captionsVtt };
  },
});
