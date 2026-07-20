"use node";

import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { extractCloudinaryPublicId } from "../lib/cloudinary";

/**
 * Backfill the `duration` field for all existing videos that have a Cloudinary
 * URL but no stored duration. Calls the Cloudinary Admin API (resource endpoint)
 * which returns duration in seconds. Safe to re-run — skips videos that already
 * have a duration set.
 */
export const backfillDurations = action({
  args: {},
  handler: async (ctx): Promise<{ updated: number; switched: number; skipped: number; total: number }> => {
    const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    const apiKey    = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error("Cloudinary credentials not configured on server.");
    }

    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

    // Use the internal query so this works from both browser (with auth) and CLI
    // (no auth). When authenticated, only processes the calling user's videos.
    const identity = await ctx.auth.getUserIdentity();
    const videos = await ctx.runQuery(internal.videos.listForBackfill, {
      clerkId: identity?.subject,
    });

    // Only process videos that lack a duration and still have their Cloudinary file
    const toProcess = videos.filter(
      (v) =>
        !v.duration &&
        v.rawFileKey?.includes("res.cloudinary.com") &&
        !v.cloudinaryDeletedAt
    );

    if (toProcess.length === 0) {
      return { updated: 0, switched: 0, skipped: 0, total: 0 };
    }

    // Fetch ALL video resources from Cloudinary in bulk (1–2 API calls instead of
    // one per video). The list endpoint returns up to 500 resources at a time.
    const durationMap = new Map<string, number>();
    let cursor: string | undefined;
    do {
      const url = new URL(`https://api.cloudinary.com/v1_1/${cloudName}/resources/video`);
      url.searchParams.set("type", "upload");
      url.searchParams.set("max_results", "500");
      if (cursor) url.searchParams.set("next_cursor", cursor);

      const res = await fetch(url.toString(), { headers: { Authorization: authHeader } });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Cloudinary list API error ${res.status}: ${body}`);
      }

      const data = await res.json() as {
        resources: Array<{ public_id: string; duration?: number }>;
        next_cursor?: string;
      };

      for (const r of data.resources) {
        if (r.duration && Number.isFinite(r.duration) && r.duration > 0) {
          durationMap.set(r.public_id, Math.round(r.duration));
        }
      }
      cursor = data.next_cursor;
    } while (cursor);

    let updated = 0;
    let switched = 0;
    let skipped = 0;

    for (const video of toProcess) {
      const cloudinaryUrl = video.processedFileKey?.includes("res.cloudinary.com")
        ? video.processedFileKey
        : video.rawFileKey;

      const publicId = extractCloudinaryPublicId(cloudinaryUrl);
      if (!publicId) { skipped++; continue; }

      const dur = durationMap.get(publicId);
      if (!dur) { skipped++; continue; }

      await ctx.runMutation(internal.videos.internalSetDuration, {
        id: video._id as any,
        duration: dur,
      });
      updated++;

      // Auto-switch videos >60s to Video mode (avoids YouTube Content ID blocks)
      if (dur > 60 && !video.publishAs) {
        await ctx.runMutation(internal.videos.internalSetPublishAs, {
          id: video._id as any,
          publishAs: "video",
        });
        switched++;
      }
    }

    return { updated, switched, skipped, total: toProcess.length };
  },
});

/** Debug helper — bypasses user-auth to inspect all videos. Run via CLI. */
export const debugVideoState = action({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.runQuery(internal.videos.debugListAll);
    const withDuration = all.filter((v) => v.duration != null);
    const withCloudinary = all.filter((v) => v.rawFileKey?.includes("res.cloudinary.com"));
    const withDeletedAt = all.filter((v) => v.cloudinaryDeletedAt != null);
    const eligible = all.filter(
      (v) =>
        v.duration == null &&
        v.rawFileKey?.includes("res.cloudinary.com") &&
        v.cloudinaryDeletedAt == null
    );
    return {
      total: all.length,
      withDuration: withDuration.length,
      withCloudinary: withCloudinary.length,
      withDeletedAt: withDeletedAt.length,
      eligibleForScan: eligible.length,
      sampleEligible: eligible.slice(0, 3).map((v) => ({
        id: v.id,
        title: v.title,
        rawFileKey: v.rawFileKey,
        status: v.status,
      })),
      sampleAll: all.slice(0, 3).map((v) => ({
        id: v.id,
        title: v.title,
        rawFileKey: v.rawFileKey,
        duration: v.duration,
        cloudinaryDeletedAt: v.cloudinaryDeletedAt,
        status: v.status,
      })),
    };
  },
});
