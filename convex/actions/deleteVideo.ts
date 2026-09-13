"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { extractCloudinaryPublicId, destroyCloudinaryAsset } from "../lib/cloudinary";

export const deleteVideo = action({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // 1. Verify ownership
    const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
    if (!video) throw new Error("Video not found");

    const user = await ctx.runQuery(api.users.current, {});
    if (!user || user._id !== video.userId) throw new Error("Unauthorized");

    // 2. Delete Cloudinary assets (best-effort — DB delete always proceeds)
    const keysToDelete = [video.rawFileKey, video.processedFileKey].filter(
      (key): key is string => !!key && key.includes("cloudinary.com")
    );

    for (const key of keysToDelete) {
      const publicId = extractCloudinaryPublicId(key);
      if (!publicId) continue;
      console.log(`[deleteVideo] Destroying Cloudinary asset: ${publicId}`);
      try {
        await destroyCloudinaryAsset(publicId, "video");
      } catch (err) {
        // Don't let a CDN cleanup failure block DB deletion — the asset may
        // already be gone (e.g. a prior post-publish cleanup or storage-health
        // failure), which is not a reason to keep the DB record around.
        console.warn(`[deleteVideo] Cloudinary destroy failed for "${publicId}":`, err);
      }
    }

    // 3. Delete related DB records and the video itself
    await ctx.runMutation(internal.videos.internalDeleteWithRelated, {
      videoId: args.videoId,
    });

    console.log(`[deleteVideo] Video ${args.videoId} deleted successfully`);
  },
});
