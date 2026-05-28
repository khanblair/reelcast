"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Extract the Cloudinary public_id from a Cloudinary URL.
 * e.g. https://res.cloudinary.com/mycloud/video/upload/v1234/generated/abc_123.mp4
 *   →  "generated/abc_123"
 */
function extractCloudinaryPublicId(url: string): string | null {
  if (!url.includes("cloudinary.com")) return null;
  // Match everything after /upload/ (strip optional version segment), remove extension
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
  return match ? match[1] : null;
}

async function destroyCloudinaryAsset(
  publicId: string,
  cloudName: string,
  apiKey: string,
  apiSecret: string,
  resourceType: "video" | "image" = "video"
): Promise<void> {
  const crypto = await import("crypto");
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureStr = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash("sha1").update(signatureStr).digest("hex");

  const form = new URLSearchParams();
  form.set("public_id", publicId);
  form.set("timestamp", timestamp.toString());
  form.set("signature", signature);
  form.set("api_key", apiKey);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`,
    { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  if (!res.ok) {
    const body = await res.text();
    console.warn(`[deleteVideo] Cloudinary destroy failed for "${publicId}": ${res.status} ${body}`);
    // Don't throw — still proceed with DB deletion even if CDN cleanup fails
  } else {
    const data = await res.json();
    console.log(`[deleteVideo] Cloudinary destroy result for "${publicId}": ${data.result}`);
  }
}

export const deleteVideo = action({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args) => {
    // 1. Verify ownership
    const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
    if (!video) throw new Error("Video not found");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.runQuery(internal.users.internalGetByClerkId, {
      clerkId: identity.subject,
    });
    if (!user || user._id !== video.userId) throw new Error("Unauthorized");

    // 2. Delete Cloudinary assets (best-effort — DB delete always proceeds)
    const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (cloudName && apiKey && apiSecret) {
      const keysToDelete = [video.rawFileKey, video.processedFileKey].filter(Boolean) as string[];

      for (const key of keysToDelete) {
        const publicId = extractCloudinaryPublicId(key);
        if (publicId) {
          console.log(`[deleteVideo] Destroying Cloudinary asset: ${publicId}`);
          await destroyCloudinaryAsset(publicId, cloudName, apiKey, apiSecret);
        }
      }
    } else {
      console.warn("[deleteVideo] Cloudinary credentials not set — skipping CDN cleanup");
    }

    // 3. Delete related DB records and the video itself
    await ctx.runMutation(internal.videos.internalDeleteWithRelated, {
      videoId: args.videoId,
    });

    console.log(`[deleteVideo] Video ${args.videoId} deleted successfully`);
  },
});
