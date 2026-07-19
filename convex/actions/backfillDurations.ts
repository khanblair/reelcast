"use node";

import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { extractCloudinaryPublicId } from "../lib/cloudinary";

/**
 * Backfill the `duration` field for all existing videos that have a Cloudinary
 * URL but no stored duration. Calls the Cloudinary Admin API (resource endpoint)
 * which returns duration in seconds. Safe to re-run — skips videos that already
 * have a duration set.
 */
export const backfillDurations = action({
  args: {},
  handler: async (ctx): Promise<{ updated: number; skipped: number; total: number }> => {
    const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    const apiKey    = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error("Cloudinary credentials not configured on server.");
    }

    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

    const videos = await ctx.runQuery(api.videos.list);

    // Only process videos that lack a duration and still have their Cloudinary file
    const toProcess = videos.filter(
      (v) =>
        !v.duration &&
        (v.rawFileKey?.includes("res.cloudinary.com") ||
          (v as any).processedFileKey?.includes("res.cloudinary.com")) &&
        !(v as any).cloudinaryDeletedAt
    );

    let updated = 0;
    let skipped = 0;

    for (const video of toProcess) {
      // Prefer the processed file URL if it exists, otherwise use rawFileKey
      const cloudinaryUrl =
        (video as any).processedFileKey?.includes("res.cloudinary.com")
          ? (video as any).processedFileKey
          : video.rawFileKey;

      const publicId = extractCloudinaryPublicId(cloudinaryUrl);
      if (!publicId) { skipped++; continue; }

      try {
        const res = await fetch(
          `https://api.cloudinary.com/v1_1/${cloudName}/resources/video/${encodeURIComponent(publicId)}`,
          { headers: { Authorization: authHeader } }
        );

        if (!res.ok) {
          console.warn(`[backfillDurations] Cloudinary API ${res.status} for ${publicId}`);
          skipped++;
          continue;
        }

        const data = await res.json() as { duration?: number };

        if (data.duration && isFinite(data.duration) && data.duration > 0) {
          await ctx.runMutation(internal.videos.internalSetDuration, {
            id: video._id as any,
            duration: Math.round(data.duration),
          });
          updated++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.warn(`[backfillDurations] Failed for video ${video._id}:`, err);
        skipped++;
      }

      // Brief pause to respect Cloudinary Admin API rate limits (500 req/hour on free plan)
      await new Promise(r => setTimeout(r, 100));
    }

    return { updated, skipped, total: toProcess.length };
  },
});
