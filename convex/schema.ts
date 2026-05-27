import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    youtubeConnected: v.boolean(),
    youtubeChannelName: v.optional(v.string()),
    youtubeAccessToken: v.optional(v.string()),
    youtubeRefreshToken: v.optional(v.string()),
    youtubeTokenExpiry: v.optional(v.number()),
  }).index("by_clerk_id", ["clerkId"]),

  videos: defineTable({
    userId: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("draft"),
      v.literal("queued"),
      v.literal("generating"),
      v.literal("ready"),
      v.literal("scheduled"),
      v.literal("publishing"),
      v.literal("published"),
      v.literal("failed")
    ),
    rawFileKey: v.string(),
    rawFileSize: v.number(),
    processedFileKey: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    duration: v.optional(v.number()),
    aiTitle: v.optional(v.string()),
    aiDescription: v.optional(v.string()),
    aiTags: v.optional(v.array(v.string())),
    aiConfig: v.optional(
      v.object({
        preset: v.optional(v.string()),
        quality: v.optional(v.string()),
        aspectRatio: v.optional(v.string()),
        captions: v.optional(v.boolean()),
        backgroundMusic: v.optional(v.boolean()),
      })
    ),
    publishedVideoId: v.optional(v.string()),
    publishedAt: v.optional(v.number()),
    scheduledPublishAt: v.optional(v.number()),
    scheduledGenerationAt: v.optional(v.number()),
    privacyStatus: v.optional(v.union(v.literal("private"), v.literal("public"), v.literal("unlisted"))),
  }).index("by_user", ["userId"]).index("by_status", ["status"]),

  jobs: defineTable({
    userId: v.id("users"),
    videoId: v.id("videos"),
    type: v.union(v.literal("generation"), v.literal("publish")),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed")
    ),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    metadata: v.optional(v.any()), // flexible for job specific metadata
  }).index("by_user", ["userId"]).index("by_video", ["videoId"]).index("by_status", ["status"]),

  settings: defineTable({
    userId: v.id("users"),
    aiPreset: v.optional(v.string()),
    defaultQuality: v.optional(v.string()),
    defaultAspectRatio: v.optional(v.string()),
    defaultCaptions: v.optional(v.boolean()),
    defaultBackgroundMusic: v.optional(v.boolean()),
    notificationsEnabled: v.boolean(),
    telegramChatId: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  notifications: defineTable({
    userId: v.id("users"),
    title: v.string(),
    message: v.string(),
    type: v.union(v.literal("info"), v.literal("success"), v.literal("warning"), v.literal("error")),
    isRead: v.boolean(),
    link: v.optional(v.string()), // optional link to a video or page
  }).index("by_user", ["userId"]).index("by_user_read", ["userId", "isRead"]),
});
