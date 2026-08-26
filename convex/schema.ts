import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    supabaseId: v.optional(v.string()),
    clerkId: v.optional(v.string()),   // kept for imported data — do not use in new queries
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    youtubeConnected: v.boolean(),
    youtubeChannelId: v.optional(v.string()),
    youtubeChannelName: v.optional(v.string()),
    youtubeAccessToken: v.optional(v.string()),
    youtubeRefreshToken: v.optional(v.string()),
    youtubeTokenExpiry: v.optional(v.number()),
    youtubeOAuthStatus: v.optional(v.union(
      v.literal("connected"),
      v.literal("token_expired"),
      v.literal("revoked"),
      v.literal("unknown"),
    )),
    isAdmin: v.optional(v.boolean()),
    plan: v.optional(v.union(v.literal("free"), v.literal("pro"), v.literal("elite"))),
    // Lemon Squeezy billing
    lemonSqueezyCustomerId: v.optional(v.string()),
    lemonSqueezySubscriptionId: v.optional(v.string()),
    lemonSqueezyVariantId: v.optional(v.string()),
    subscriptionStatus: v.optional(v.union(
      v.literal("on_trial"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("past_due"),
      v.literal("unpaid"),
      v.literal("cancelled"),
      v.literal("expired"),
    )),
    subscriptionRenewsAt: v.optional(v.number()),
    subscriptionEndsAt: v.optional(v.number()),
  })
    .index("by_supabase_id", ["supabaseId"])
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"])
    .index("by_youtube_channel_id", ["youtubeChannelId"])
    .index("by_lemonsqueezy_customer_id", ["lemonSqueezyCustomerId"])
    .index("by_lemonsqueezy_subscription_id", ["lemonSqueezySubscriptionId"]),

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
    metadataHistory: v.optional(v.array(v.object({
      savedAt: v.number(),
      aiTitle: v.optional(v.string()),
      aiDescription: v.optional(v.string()),
      aiTags: v.optional(v.array(v.string())),
    }))),
    thumbnailGeneratedUrl: v.optional(v.string()),
    captionsVtt: v.optional(v.string()),
    youtubeChannelId: v.optional(v.string()),
    aiConfig: v.optional(
      v.object({
        model: v.optional(v.string()),
        prompt: v.optional(v.string()),
        negativePrompt: v.optional(v.string()),
        resolution: v.optional(v.string()),
        aspectRatio: v.optional(v.string()),
        durationSeconds: v.optional(v.number()),
        fps: v.optional(v.number()),
        generateAudio: v.optional(v.boolean()),
        enhancePrompt: v.optional(v.boolean()),
        numberOfVideos: v.optional(v.number()),
        personGeneration: v.optional(v.string()),
        seed: v.optional(v.number()),
        preset: v.optional(v.string()),
        quality: v.optional(v.string()),
        captions: v.optional(v.boolean()),
        backgroundMusic: v.optional(v.boolean()),
      })
    ),
    veoOperationName: v.optional(v.string()),
    veoOperationDone: v.optional(v.boolean()),
    sourceType: v.optional(v.union(v.literal("upload"), v.literal("generate"))),
    publishedVideoId: v.optional(v.string()),
    publishedAt: v.optional(v.number()),
    scheduledPublishAt: v.optional(v.number()),
    metadataScheduledAt: v.optional(v.number()),
    metadataSchedulerId: v.optional(v.id("_scheduled_functions")),
    convexSchedulerId: v.optional(v.id("_scheduled_functions")),
    cloudinaryDeletedAt: v.optional(v.number()),
    storageMissing: v.optional(v.boolean()),
    storageCheckedAt: v.optional(v.number()),
    privacyStatus: v.optional(v.union(v.literal("private"), v.literal("public"), v.literal("unlisted"))),
    publishAs: v.optional(v.union(v.literal("short"), v.literal("video"))),
    publishOrder: v.optional(v.number()),
  }).index("by_user", ["userId"]).index("by_status", ["status"]).index("by_user_status", ["userId", "status"]),

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
    metadata: v.optional(v.any()),
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
    discordWebhookUrl: v.optional(v.string()),
    // per-event notification toggles
    notifyOnPublishSuccess: v.optional(v.boolean()),
    notifyOnPublishFailure: v.optional(v.boolean()),
    notifyOnMetadataReady: v.optional(v.boolean()),
    notifyOnWeeklyDigest: v.optional(v.boolean()),
    notifyOnStorageWarning: v.optional(v.boolean()),
    discordMessageTemplate: v.optional(v.string()),
    telegramMessageTemplate: v.optional(v.string()),
    // BYOK: email (Resend)
    resendApiKey: v.optional(v.string()),
    emailFromAddress: v.optional(v.string()),
    emailNotificationsEnabled: v.optional(v.boolean()),
    // BYOK: DeepSeek (AI Assistant)
    deepseekApiKey: v.optional(v.string()),
    // AI metadata
    aiAutoGenerate: v.optional(v.boolean()),
    aiGenerateTitle: v.optional(v.boolean()),
    aiGenerateDescription: v.optional(v.boolean()),
    aiGenerateTags: v.optional(v.boolean()),
    aiTone: v.optional(v.string()),
    aiLanguage: v.optional(v.string()),
    aiDescriptionLength: v.optional(v.string()),
    aiGuidelines: v.optional(v.string()),
    // AI brand memory (structured)
    aiNiche: v.optional(v.string()),
    aiTargetAudience: v.optional(v.string()),
    aiBrandVoice: v.optional(v.string()),
    aiForbiddenWords: v.optional(v.string()),
    aiCtaPreferences: v.optional(v.string()),
    // Content intelligence
    competitorChannelIds: v.optional(v.array(v.string())),
    // Auto-publish
    autoPublishEnabled: v.optional(v.boolean()),
    autoPublishIntervalMs: v.optional(v.number()),
    autoPublishCount: v.optional(v.number()),
    autoPublishPrivacy: v.optional(v.union(v.literal("private"), v.literal("public"), v.literal("unlisted"))),
    autoPublishSchedulerId: v.optional(v.id("_scheduled_functions")),
    autoPublishNextAt: v.optional(v.number()),
    autoPublishTimeSlots: v.optional(v.array(v.number())),
    autoPublishTimezoneOffset: v.optional(v.number()),
    // Writing style
    humanizeWriting: v.optional(v.boolean()),
    // Veo defaults
    veoModel: v.optional(v.string()),
    veoResolution: v.optional(v.string()),
    veoAspectRatio: v.optional(v.string()),
    veoDurationSeconds: v.optional(v.number()),
    veoGenerateAudio: v.optional(v.boolean()),
    veoEnhancePrompt: v.optional(v.boolean()),
    veoPersonGeneration: v.optional(v.string()),
    veoNumberOfVideos: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  generations: defineTable({
    userId: v.id("users"),
    videoId: v.id("videos"),
    model: v.string(),
    prompt: v.string(),
    negativePrompt: v.optional(v.string()),
    resolution: v.string(),
    aspectRatio: v.string(),
    durationSeconds: v.number(),
    generateAudio: v.boolean(),
    status: v.union(
      v.literal("submitted"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed")
    ),
    veoOperationName: v.optional(v.string()),
    outputVideoUrl: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    error: v.optional(v.string()),
    generationTimeMs: v.optional(v.number()),
  }).index("by_user", ["userId"]).index("by_video", ["videoId"]).index("by_status", ["status"]),

  notifications: defineTable({
    userId: v.id("users"),
    title: v.string(),
    message: v.string(),
    type: v.union(v.literal("info"), v.literal("success"), v.literal("warning"), v.literal("error")),
    isRead: v.boolean(),
    link: v.optional(v.string()),
  }).index("by_user", ["userId"]).index("by_user_read", ["userId", "isRead"]),

  // YouTube Analytics data cached from the YouTube Analytics API
  videoAnalytics: defineTable({
    userId: v.id("users"),
    videoId: v.id("videos"),
    youtubeVideoId: v.string(),
    fetchedAt: v.number(),
    views: v.optional(v.number()),
    watchTimeMinutes: v.optional(v.number()),
    avgViewDurationSec: v.optional(v.number()),
    impressions: v.optional(v.number()),
    ctr: v.optional(v.number()),
    likes: v.optional(v.number()),
    comments: v.optional(v.number()),
    subscribersGained: v.optional(v.number()),
    estimatedRevenue: v.optional(v.number()),
    rpm: v.optional(v.number()),
    cpm: v.optional(v.number()),
    trafficSourceSearch: v.optional(v.number()),
    trafficSourceSuggested: v.optional(v.number()),
    trafficSourceExternal: v.optional(v.number()),
  }).index("by_user", ["userId"]).index("by_video", ["videoId"]).index("by_user_fetched", ["userId", "fetchedAt"]),

  // Idea Vault — user-saved content ideas
  ideas: defineTable({
    userId: v.id("users"),
    title: v.string(),
    notes: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    status: v.union(v.literal("concept"), v.literal("in_production"), v.literal("published")),
    scheduledGenerateAt: v.optional(v.number()),
    linkedVideoId: v.optional(v.id("videos")),
  }).index("by_user", ["userId"]).index("by_status", ["status"]),

  // AI Assistant chat sessions
  aiSessions: defineTable({
    userId: v.id("users"),
    title: v.optional(v.string()),
    lastMessageAt: v.number(),
  }).index("by_user", ["userId"]),

  // AI Assistant message history (DeepSeek chat)
  aiMessages: defineTable({
    userId: v.id("users"),
    sessionId: v.optional(v.id("aiSessions")),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    toolCalls: v.optional(v.any()),
  }).index("by_user", ["userId"]).index("by_session", ["sessionId"]),

  // Daily YouTube API quota usage tracking
  youtubeQuotaUsage: defineTable({
    userId: v.id("users"),
    date: v.string(), // YYYY-MM-DD
    unitsUsed: v.number(),
  }).index("by_user", ["userId"]).index("by_user_date", ["userId", "date"]),

  // Monthly usage metering for Free/Pro/Elite plan limits
  usageLedger: defineTable({
    userId: v.id("users"),
    month: v.string(), // YYYY-MM
    videosUploaded: v.optional(v.number()),
    metadataGenerated: v.optional(v.number()),
    veoGenerated: v.optional(v.number()),
    aiMessagesUsed: v.optional(v.number()),
  }).index("by_user", ["userId"]).index("by_user_month", ["userId", "month"]),

  // Connected YouTube channels per user (multi-channel support)
  youtubeChannels: defineTable({
    userId: v.id("users"),
    channelId: v.string(),       // YouTube channel ID — unique across all accounts
    channelName: v.optional(v.string()),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiry: v.number(),
    oauthStatus: v.optional(v.union(
      v.literal("connected"),
      v.literal("token_expired"),
      v.literal("revoked"),
      v.literal("unknown"),
    )),
    isPrimary: v.optional(v.boolean()),
  })
    .index("by_user", ["userId"])
    .index("by_channel_id", ["channelId"]),

  // Singleton table — one row stores all platform-level API keys set by admin
  platformSettings: defineTable({
    deepseekApiKey: v.optional(v.string()),
    geminiApiKey: v.optional(v.string()),
  }),

  // Lemon Squeezy webhook event log — idempotency guard + audit trail
  billingEvents: defineTable({
    eventId: v.string(),        // Lemon Squeezy webhook meta.event_name + object id, de-duped key
    eventName: v.string(),      // e.g. "subscription_created"
    userId: v.optional(v.id("users")),
    subscriptionId: v.optional(v.string()),
    processedAt: v.number(),
  }).index("by_event_id", ["eventId"]),

  // Contact form submissions from the marketing site
  contactSubmissions: defineTable({
    name: v.string(),
    email: v.string(),
    subject: v.string(),
    message: v.string(),
    status: v.union(v.literal("new"), v.literal("read")),
  }).index("by_status", ["status"]),
});
