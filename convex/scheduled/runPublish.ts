"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { uploadToYouTube, refreshYouTubeToken } from "../lib/youtube";

export const processPublishJob = action({
  args: { jobId: v.id("jobs"), videoId: v.id("videos") },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.jobs.internalUpdateStatus, {
      id: args.jobId,
      status: "processing",
    });

    try {
      const video = await ctx.runQuery(internal.videos.internalGet, { id: args.videoId });
      if (!video) throw new Error("Video not found");

      const user = await ctx.runQuery(internal.users.internalGetById, { userId: video.userId });
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

      const videoFileUrl = video.processedFileKey ?? video.rawFileKey;
      const title = video.aiTitle ?? video.title;
      const description = video.aiDescription ?? video.description ?? "";
      const tags = video.aiTags ?? video.tags ?? [];

      const youtubeVideoId = await uploadToYouTube({
        accessToken,
        title,
        description,
        tags,
        videoUrl: videoFileUrl,
        privacyStatus: video.privacyStatus ?? "private",
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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Unknown error";

      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "failed",
        error: message,
      });

      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "failed",
      });
    }
  },
});
