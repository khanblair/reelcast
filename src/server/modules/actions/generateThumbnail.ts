// Port of convex/actions/generateThumbnail.ts. Export ONLY rpc definitions from this file.
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { videos } from "@/db/schema";
import { createGeminiClient } from "@/server/lib/ai";
import { meterFrameAi } from "@/server/lib/ai/frameQuota";
import { GEMINI_MODEL } from "@/server/lib/ai/metadata";
import { fetchFrames, framePart, isCloudinaryUrl } from "@/server/lib/ai/video";
import { GEMINI_NOT_CONFIGURED } from "@/server/lib/generation/common";
import { getPlatformKey } from "@/server/lib/platformKeys";
import { action } from "../../rpc/define";
import { badRequest, notFound } from "../../rpc/errors";

// Cloudinary frame offsets Gemini chooses the best thumbnail from.
const FRAME_OFFSETS = ["so_5p", "so_20p", "so_40p", "so_60p", "so_80p"];
const DEFAULT_OFFSET = "so_25p";

export const generate = action({
  input: z.object({ videoId: z.string().uuid() }),
  handler: async (ctx, args): Promise<{ thumbnailUrl: string }> => {
    const { db, userId } = ctx;
    const [video] = await db
      .select()
      .from(videos)
      .where(and(eq(videos.id, args.videoId), eq(videos.userId, userId)))
      .limit(1);
    if (!video) throw notFound("Video not found");

    const geminiKey = await getPlatformKey(db, "gemini");
    if (!geminiKey) throw badRequest(GEMINI_NOT_CONFIGURED);
    if (!isCloudinaryUrl(video.rawFileKey)) throw badRequest("Thumbnail generation requires a Cloudinary-hosted video.");

    // Metered like metadata.generateForUpload (same counter, see frameQuota.ts). The checks above cost the user nothing;
    // from here on a unit is spent. It is refunded whenever Gemini does not pick a frame (no frames, Gemini error, or the
    // save failing), because the default 25 % frame needs no AI. An unparsable Gemini reply stays charged: the call ran.
    const meter = await meterFrameAi(db, userId, ctx.user.plan);
    try {
      const title = video.aiTitle ?? video.title;
      const frames = await fetchFrames(video.rawFileKey, FRAME_OFFSETS);

      let bestOffset = DEFAULT_OFFSET;
      if (frames.length === 0) {
        await meter.refund(); // no AI pick happens: the default frame is free
      } else {
        try {
          const res = await createGeminiClient(geminiKey).models.generateContent({
            model: GEMINI_MODEL,
            contents: [
              {
                role: "user",
                parts: [
                  ...frames.map(framePart),
                  {
                    text:
                      `These are ${frames.length} frames from a YouTube Short titled "${title}". ` +
                      `Which frame index (0 to ${frames.length - 1}, zero-based) would make the most compelling YouTube thumbnail? ` +
                      `Consider: clear subject, interesting composition, good lighting, and emotional impact. ` +
                      `Reply with ONLY the index number (e.g. "2"), nothing else.`,
                  },
                ],
              },
            ],
            config: { httpOptions: { timeout: 25_000 } },
          });
          const idx = parseInt((res.text ?? "").trim(), 10);
          if (!Number.isNaN(idx) && idx >= 0 && idx < frames.length) bestOffset = frames[idx].transform;
        } catch {
          // Fall back to the 25 % frame, exactly like Convex. The pick did not happen, so the unit goes back.
          await meter.refund();
        }
      }

      const thumbnailUrl = video.rawFileKey
        .replace("/upload/", `/upload/${bestOffset},w_1280,h_720,c_fill,e_sharpen,e_vibrance:50/`)
        .replace(/\.(mp4|mov|avi|mkv|webm|flv|wmv)(\?.*)?$/, ".jpg");

      await db.update(videos).set({ thumbnailGeneratedUrl: thumbnailUrl, updatedAt: new Date() }).where(and(eq(videos.id, video.id), eq(videos.userId, userId)));
      return { thumbnailUrl };
    } catch (e) {
      await meter.refund();
      throw e;
    }
  },
});
