"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { uploadToYouTube, refreshYouTubeToken } from "../lib/youtube";
import {
  extractCloudinaryPublicId,
  destroyCloudinaryAsset,
} from "../lib/cloudinary";

const MAX_RETRIES = 2; // 3 total attempts: 0, 1, 2

// Errors that will never succeed on retry — fail fast without burning attempts
function isNonRetryable(message: string): boolean {
  return (
    message.includes("Not Found") ||             // storage 404 — file is gone
    message.includes("Video not found") ||        // record deleted mid-flight
    message.includes("User not found") ||         // account deleted
    message.includes("VIDEO_FILE_DELETED") ||     // explicit deleted flag
    message.includes("YouTube account is not connected") // no OAuth at all
  );
}

// Tailor the Telegram notification copy to the actual failure cause
function userFacingError(message: string): string {
  if (message.includes("VIDEO_FILE_DELETED") || message.includes("Not Found")) {
    return "The video file is no longer in storage (it may have been cleaned up after a previous publish). Re-upload the video to publish it again.";
  }
  if (message.includes("YouTube account is not connected")) {
    return "Your YouTube account is not connected. Go to Settings → YouTube Channels to reconnect.";
  }
  if (message.includes("YouTube upload initiation failed") || message.includes("YouTube video upload failed")) {
    return `YouTube rejected the upload: ${message}`;
  }
  return message;
}

export const processPublishJob = action({
  args: {
    jobId: v.id("jobs"),
    videoId: v.id("videos"),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const attempt = args.attempt ?? 0;

    // Only mark as "processing" on the first attempt
    if (attempt === 0) {
      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "processing",
      });
    }

    let title = "Unknown";

    try {
      const video = await ctx.runQuery(internal.videos.internalGet, {
        id: args.videoId,
      });
      if (!video) throw new Error("Video not found");

      const user = await ctx.runQuery(internal.users.internalGetById, {
        userId: video.userId,
      });
      if (!user) throw new Error("User not found");
      if (!user.youtubeConnected || !user.youtubeAccessToken) {
        throw new Error("YouTube account is not connected");
      }

      let accessToken = user.youtubeAccessToken;

      // Refresh token if it expires within 5 minutes
      if (user.youtubeRefreshToken && user.youtubeTokenExpiry) {
        const expiresIn = user.youtubeTokenExpiry - Date.now();
        if (expiresIn < 5 * 60 * 1000) {
          const refreshed = await refreshYouTubeToken(user.youtubeRefreshToken);
          accessToken = refreshed.accessToken;
          await ctx.runMutation(internal.users.internalUpdateYoutubeTokens, {
            userId: user._id,
            accessToken: refreshed.accessToken,
            expiresIn: refreshed.expiresIn,
          });
        }
      }

      // Pre-flight: if Cloudinary already cleaned up this video's files, fail fast
      // instead of hitting a 404 after making a resumable-upload request to YouTube.
      if ((video as any).cloudinaryDeletedAt) {
        throw new Error("VIDEO_FILE_DELETED: The video file was cleaned up after a previous successful publish. Re-upload to publish again.");
      }

      const videoFileUrl = video.processedFileKey ?? video.rawFileKey;
      title = video.aiTitle ?? video.title;
      const description = video.aiDescription ?? video.description ?? "";
      const tags = video.aiTags ?? video.tags ?? [];

      const youtubeVideoId = await uploadToYouTube({
        accessToken,
        title,
        description,
        tags,
        videoUrl: videoFileUrl,
        privacyStatus: video.privacyStatus ?? "public",
        publishAs: (video as any).publishAs ?? "short",
      });

      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "published",
      });

      await ctx.runMutation(internal.videos.internalSetPublishedData, {
        id: args.videoId,
        publishedVideoId: youtubeVideoId,
        publishedAt: Date.now(),
      });

      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "completed",
      });

      // Success notification
      await ctx.runAction(api.actions.telegram.sendNotification, {
        userId: video.userId,
        message: `🎬 Published: "${title}" is now live on YouTube!\nhttps://youtu.be/${youtubeVideoId}`,
      }).catch(() => {});

      // Best-effort Cloudinary cleanup after successful upload
      const cloudinaryUrls: string[] = [];
      if (video.processedFileKey?.includes("cloudinary.com")) {
        cloudinaryUrls.push(video.processedFileKey);
      }
      if (
        video.rawFileKey?.includes("cloudinary.com") &&
        video.rawFileKey !== video.processedFileKey
      ) {
        cloudinaryUrls.push(video.rawFileKey);
      }

      for (const url of cloudinaryUrls) {
        const publicId = extractCloudinaryPublicId(url);
        if (!publicId) {
          console.warn(`[runPublish] Could not extract Cloudinary publicId from URL: ${url}`);
          continue;
        }
        try {
          await destroyCloudinaryAsset(publicId, "video");
        } catch (cleanupErr) {
          console.warn(
            `[runPublish] Cloudinary cleanup failed for publicId "${publicId}":`,
            cleanupErr
          );
        }
      }

      if (cloudinaryUrls.length > 0) {
        try {
          await ctx.runMutation(internal.videos.internalSetCloudinaryDeleted, {
            id: args.videoId,
          });
        } catch (cleanupErr) {
          console.warn(
            "[runPublish] Failed to record cloudinaryDeletedAt:",
            cleanupErr
          );
        }
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";

      const nonRetryable = isNonRetryable(message);

      if (!nonRetryable && attempt < MAX_RETRIES) {
        // Schedule retry with exponential backoff: 60s, 120s
        const delayMs = 60_000 * Math.pow(2, attempt);
        await ctx.scheduler.runAfter(
          delayMs,
          api.scheduled.runPublish.processPublishJob,
          { jobId: args.jobId, videoId: args.videoId, attempt: attempt + 1 }
        );
        // Do not mark job as failed — it is still pending a retry
        return;
      }

      // Non-retryable error or all retries exhausted — mark as failed
      const attemptsLabel = nonRetryable ? "1 attempt" : "3 attempts";
      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "failed",
        error: message,
      });

      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "failed",
      });

      // Best-effort Telegram notification with context-aware message
      try {
        const video = await ctx.runQuery(internal.videos.internalGet, {
          id: args.videoId,
        });
        if (video) {
          const notificationTitle = video.aiTitle ?? video.title ?? title;
          const friendlyError = userFacingError(message);
          await ctx.runAction(api.actions.telegram.sendNotification, {
            userId: video.userId,
            message: `❌ Publish failed: "${notificationTitle}" after ${attemptsLabel}.\n\nReason: ${friendlyError}`,
          });
        }
      } catch (telegramErr) {
        console.warn(
          "[runPublish] Telegram notification failed:",
          telegramErr
        );
      }
    }
  },
});
