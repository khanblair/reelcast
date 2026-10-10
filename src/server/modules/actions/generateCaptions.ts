// Port of convex/actions/generateCaptions.ts. Export ONLY rpc definitions from this file.
// Cloudinary videos are transcribed from evenly sampled frames (seconds, not minutes), which keeps
// the action well inside the rpc time guideline; the Convex Files-API branch served non-Cloudinary
// hosts, which the server no longer fetches (SSRF), so it is not ported.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { videos } from "@/db/schema";
import { createGeminiClient } from "@/server/lib/ai";
import { meterFrameAi } from "@/server/lib/ai/frameQuota";
import { GEMINI_MODEL } from "@/server/lib/ai/metadata";
import { fetchFrames, framePart, isCloudinaryUrl } from "@/server/lib/ai/video";
import { GEMINI_NOT_CONFIGURED, publicError } from "@/server/lib/generation/common";
import { getPlatformKey } from "@/server/lib/platformKeys";
import { action } from "../../rpc/define";
import { badRequest, notFound } from "../../rpc/errors";

const MAX_VTT_CHARS = 200_000;

export const generate = action({
  input: z.object({ videoId: z.string().uuid() }),
  handler: async (ctx, args): Promise<{ captionsVtt: string }> => {
    const { db, userId } = ctx;
    const [video] = await db
      .select()
      .from(videos)
      .where(and(eq(videos.id, args.videoId), eq(videos.userId, userId)))
      .limit(1);
    if (!video) throw notFound("Video not found");

    const geminiKey = await getPlatformKey(db, "gemini");
    if (!geminiKey) throw badRequest(GEMINI_NOT_CONFIGURED);
    if (!isCloudinaryUrl(video.rawFileKey)) throw badRequest("Caption generation requires a Cloudinary-hosted video.");

    // Metered like metadata.generateForUpload (same counter, see frameQuota.ts). The checks above cost the user nothing;
    // from here on a unit is spent, and it is given back when no captions come out of the call.
    const meter = await meterFrameAi(db, userId, ctx.user.plan);
    try {
      const duration = video.duration && video.duration > 0 ? video.duration : 60;
      // One frame per ~6 seconds, 2..10 frames, spread over 0-100 % of the clip.
      const numSamples = Math.max(2, Math.min(10, Math.ceil(duration / 6)));
      const offsets = Array.from({ length: numSamples }, (_, i) => `so_${Math.round((i / (numSamples - 1)) * 100)}p`);

      const frames = await fetchFrames(video.rawFileKey, offsets);
      if (frames.length === 0) throw badRequest("Could not extract frames from the video. Try again in a moment.");

      const ai = createGeminiClient(geminiKey);
      let text: string;
      try {
        const res = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                ...frames.map(framePart),
                {
                  text:
                    `These are ${frames.length} frames evenly sampled from a ${duration}-second video titled "${video.aiTitle ?? video.title}". ` +
                    `Each frame represents approximately ${Math.round(duration / frames.length)} seconds of video. ` +
                    `Read all visible text (on-screen captions, quotes, graphics) and infer spoken content from the visual context. ` +
                    `Generate a transcript with approximate timestamps in WebVTT format. ` +
                    `Use the frame sequence to estimate when text appears and disappears. ` +
                    `Return ONLY valid WebVTT content starting with "WEBVTT", nothing else. Example format:\n\nWEBVTT\n\n00:00:00.000 --> 00:00:03.000\nFirst line of spoken or on-screen text`,
                },
              ],
            },
          ],
          config: { httpOptions: { timeout: 40_000 } },
        });
        text = res.text ?? "";
      } catch (e) {
        throw publicError("Caption generation failed", e);
      }

      // Clean up any markdown fences.
      let captionsVtt = text.replace(/```[a-z]*\n?/g, "").replace(/```\n?/g, "").trim();
      if (!captionsVtt.startsWith("WEBVTT")) captionsVtt = "WEBVTT\n\n" + captionsVtt;
      captionsVtt = captionsVtt.slice(0, MAX_VTT_CHARS);

      await db.update(videos).set({ captionsVtt, updatedAt: new Date() }).where(and(eq(videos.id, video.id), eq(videos.userId, userId)));
      return { captionsVtt };
    } catch (e) {
      await meter.refund();
      throw e;
    }
  },
});
