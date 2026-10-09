/**
 * Postgres schema (Supabase). Replaces convex/schema.ts.
 *
 * Conventions
 *  - snake_case columns via drizzle `casing: "snake_case"`; camelCase here.
 *  - Every id is a uuid. `users.id` IS the Supabase auth user id (FK to auth.users).
 *  - Enums are `text` + CHECK (easier to evolve than pg enums).
 *  - Timestamps are timestamptz. The RPC wire format converts them to epoch-ms numbers.
 *  - Secrets (OAuth tokens, BYOK keys, provider credentials) are stored encrypted with
 *    `src/server/crypto.ts` (AES-256-GCM). They are never returned to the browser.
 *  - All tables are RLS-locked with no policies and no grants to anon/authenticated
 *    (see the custom migration). The app reads/writes only through the server DB role.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  date,
} from "drizzle-orm/pg-core";

// ─── Enum value lists (single source of truth for CHECKs and TS unions) ──────
export const PLANS = ["free", "pro", "elite"] as const;
export const PLAN_SOURCES = ["default", "subscription", "admin"] as const;
export const OAUTH_STATUSES = ["connected", "token_expired", "revoked", "unknown"] as const;
export const VIDEO_STATUSES = [
  "draft",
  "queued",
  "generating",
  "ready",
  "scheduled",
  "publishing",
  "published",
  "failed",
] as const;
export const PRIVACY_STATUSES = ["private", "public", "unlisted"] as const;
export const PUBLISH_AS = ["short", "video"] as const;
export const SOURCE_TYPES = ["upload", "generate"] as const;
export const JOB_TYPES = ["generation", "publish"] as const;
export const JOB_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export const GENERATION_STATUSES = ["submitted", "processing", "completed", "failed"] as const;
export const NOTIFICATION_TYPES = ["info", "success", "warning", "error"] as const;
export const IDEA_STATUSES = ["concept", "in_production", "published"] as const;
export const AI_ROLES = ["user", "assistant"] as const;
export const CONTACT_STATUSES = ["new", "read"] as const;
export const TASK_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;
export const SUBSCRIPTION_STATUSES = [
  "approval_pending",
  "active",
  "past_due",
  "cancelled",
  "expired",
] as const;
export const PAYMENT_PURPOSES = ["initial", "renewal", "upgrade"] as const;
export const PAYMENT_PROVIDERS = ["pesapal"] as const;

type Tuple = readonly string[];
const inList = (col: string, values: Tuple) =>
  sql.raw(`${col} in (${values.map((v) => `'${v}'`).join(", ")})`);

const ts = (name?: string) =>
  (name ? timestamp(name, { withTimezone: true }) : timestamp({ withTimezone: true }));
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

// ─── users ───────────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    /** = auth.users.id (FK added in the custom migration, ON DELETE CASCADE). */
    id: uuid().primaryKey(),
    email: text().notNull(),
    name: text(),
    imageUrl: text(),
    isAdmin: boolean().notNull().default(false),
    /** Effective entitlement tier. Set only by billing code or an admin. */
    plan: text({ enum: PLANS }).notNull().default("free"),
    /** Who last set `plan`; lets a subscription lapse without wiping an admin grant. */
    planSource: text({ enum: PLAN_SOURCES }).notNull().default("default"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(sql`lower(${t.email})`),
    index("users_created_idx").on(t.createdAt),
    check("users_plan_chk", inList("plan", PLANS)),
    check("users_plan_source_chk", inList("plan_source", PLAN_SOURCES)),
  ],
);

// ─── youtube_channels ────────────────────────────────────────────────────────
export const youtubeChannels = pgTable(
  "youtube_channels",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    /** YouTube channel id; one channel can be connected to only one account. */
    channelId: text().notNull(),
    channelName: text(),
    /** Encrypted. */
    accessToken: text().notNull(),
    /** Encrypted. */
    refreshToken: text(),
    tokenExpiry: ts().notNull(),
    oauthStatus: text({ enum: OAUTH_STATUSES }).default("connected"),
    isPrimary: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("youtube_channels_channel_id_idx").on(t.channelId),
    index("youtube_channels_user_idx").on(t.userId),
    // At most one primary channel per user.
    uniqueIndex("youtube_channels_one_primary_idx").on(t.userId).where(sql`is_primary`),
    check("youtube_channels_oauth_chk", inList("oauth_status", OAUTH_STATUSES)),
  ],
);

// ─── videos ──────────────────────────────────────────────────────────────────
export type AiConfig = {
  model?: string;
  prompt?: string;
  negativePrompt?: string;
  resolution?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  fps?: number;
  generateAudio?: boolean;
  enhancePrompt?: boolean;
  numberOfVideos?: number;
  personGeneration?: string;
  seed?: number;
  preset?: string;
  quality?: string;
  captions?: boolean;
  backgroundMusic?: boolean;
};

export const videos = pgTable(
  "videos",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    description: text(),
    tags: text().array(),
    status: text({ enum: VIDEO_STATUSES }).notNull().default("draft"),
    /** Cloudinary URL of the raw upload (historical name kept for the UI). */
    rawFileKey: text().notNull(),
    rawFileSize: bigint({ mode: "number" }).notNull(),
    processedFileKey: text(),
    thumbnailUrl: text(),
    duration: doublePrecision(),
    aiTitle: text(),
    aiDescription: text(),
    aiTags: text().array(),
    thumbnailGeneratedUrl: text(),
    captionsVtt: text(),
    youtubeChannelId: text(),
    aiConfig: jsonb().$type<AiConfig>(),
    veoOperationName: text(),
    veoOperationDone: boolean(),
    sourceType: text({ enum: SOURCE_TYPES }),
    publishedVideoId: text(),
    publishedAt: ts(),
    /** Source of truth for scheduled publishing; the tick turns due rows into jobs. */
    scheduledPublishAt: ts(),
    metadataScheduledAt: ts(),
    cloudinaryDeletedAt: ts(),
    storageMissing: boolean(),
    storageCheckedAt: ts(),
    privacyStatus: text({ enum: PRIVACY_STATUSES }),
    publishAs: text({ enum: PUBLISH_AS }),
    publishOrder: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("videos_user_idx").on(t.userId, t.createdAt),
    index("videos_user_status_idx").on(t.userId, t.status),
    index("videos_due_idx").on(t.scheduledPublishAt).where(sql`status = 'scheduled'`),
    index("videos_created_idx").on(t.createdAt),
    index("videos_user_scheduled_idx").on(t.userId, t.createdAt.desc()).where(sql`scheduled_publish_at is not null`),
    index("videos_metadata_due_idx").on(t.metadataScheduledAt).where(sql`metadata_scheduled_at is not null`),
    check("videos_status_chk", inList("status", VIDEO_STATUSES)),
    check("videos_privacy_chk", inList("privacy_status", PRIVACY_STATUSES)),
    check("videos_publish_as_chk", inList("publish_as", PUBLISH_AS)),
    check("videos_source_chk", inList("source_type", SOURCE_TYPES)),
  ],
);

/** Replaces videos.metadataHistory[] (append-only, unbounded in Convex arrays). */
export const videoMetadataVersions = pgTable(
  "video_metadata_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    videoId: uuid().notNull().references(() => videos.id, { onDelete: "cascade" }),
    savedAt: ts().notNull().defaultNow(),
    aiTitle: text(),
    aiDescription: text(),
    aiTags: text().array(),
  },
  (t) => [index("video_metadata_versions_video_idx").on(t.videoId, t.savedAt)],
);

// ─── jobs (user-visible, claimable) and tasks (system queue) ─────────────────
export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    videoId: uuid().notNull().references(() => videos.id, { onDelete: "cascade" }),
    type: text({ enum: JOB_TYPES }).notNull(),
    status: text({ enum: JOB_STATUSES }).notNull().default("pending"),
    error: text(),
    startedAt: ts(),
    completedAt: ts(),
    metadata: jsonb(),
    /** Queue fields: claimable when status='pending' and run_at <= now(). */
    runAt: ts().notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    lockedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_user_idx").on(t.userId, t.createdAt),
    index("jobs_video_idx").on(t.videoId),
    index("jobs_claim_idx").on(t.runAt).where(sql`status = 'pending'`),
    index("jobs_created_idx").on(t.createdAt),
    index("jobs_status_created_idx").on(t.status, t.createdAt),
    // One active job of a type per video: blocks duplicate publish/generation enqueue.
    uniqueIndex("jobs_one_active_per_video_type_idx")
      .on(t.videoId, t.type)
      .where(sql`status in ('pending', 'processing')`),
    check("jobs_type_chk", inList("type", JOB_TYPES)),
    check("jobs_status_chk", inList("status", JOB_STATUSES)),
  ],
);

/**
 * Generic system task queue: Veo polling, auto-publish batches, scheduled metadata,
 * digests, health sweeps. `dedupeKey` replaces Convex scheduler ids: a pending task
 * with the same key is unique, and cancelling = updating status.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    status: text({ enum: TASK_STATUSES }).notNull().default("pending"),
    runAt: ts().notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(3),
    lockedAt: ts(),
    lastError: text(),
    dedupeKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_claim_idx").on(t.runAt).where(sql`status = 'pending'`),
    uniqueIndex("tasks_dedupe_idx").on(t.dedupeKey).where(sql`dedupe_key is not null and status in ('pending', 'running')`),
    check("tasks_status_chk", inList("status", TASK_STATUSES)),
  ],
);

/**
 * Periodic duties (the Convex `crons` replacement). The tick atomically "claims" a sweep
 * by advancing last_run_at, so overlapping ticks never run the same sweep twice.
 */
export const jobSchedules = pgTable("job_schedules", {
  name: text().primaryKey(),
  lastRunAt: ts(),
  /** Lease so a crashed sweep is retried after it expires. */
  leaseUntil: ts(),
  lastError: text(),
});

// ─── settings (one row per user) ─────────────────────────────────────────────
export const settings = pgTable(
  "settings",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    aiPreset: text(),
    defaultQuality: text(),
    defaultAspectRatio: text(),
    defaultCaptions: boolean(),
    defaultBackgroundMusic: boolean(),
    notificationsEnabled: boolean().notNull().default(true),
    telegramChatId: text(),
    discordWebhookUrl: text(),
    notifyOnPublishSuccess: boolean(),
    notifyOnPublishFailure: boolean(),
    notifyOnMetadataReady: boolean(),
    notifyOnWeeklyDigest: boolean(),
    notifyOnStorageWarning: boolean(),
    discordMessageTemplate: text(),
    telegramMessageTemplate: text(),
    /** BYOK Resend key. Encrypted; never returned to the browser. */
    resendApiKey: text(),
    emailFromAddress: text(),
    emailNotificationsEnabled: boolean(),
    /** BYOK DeepSeek key. Encrypted; never returned to the browser. */
    deepseekApiKey: text(),
    aiAutoGenerate: boolean(),
    aiGenerateTitle: boolean(),
    aiGenerateDescription: boolean(),
    aiGenerateTags: boolean(),
    aiTone: text(),
    aiLanguage: text(),
    aiDescriptionLength: text(),
    aiGuidelines: text(),
    aiNiche: text(),
    aiTargetAudience: text(),
    aiBrandVoice: text(),
    aiForbiddenWords: text(),
    aiCtaPreferences: text(),
    competitorChannelIds: text().array(),
    autoPublishEnabled: boolean(),
    autoPublishIntervalMs: bigint({ mode: "number" }),
    autoPublishCount: integer(),
    autoPublishPrivacy: text({ enum: PRIVACY_STATUSES }),
    autoPublishNextAt: ts(),
    autoPublishTimeSlots: integer().array(),
    /** Hours from UTC; fractional zones exist (IST = 5.5, Nepal = 5.75). */
    autoPublishTimezoneOffset: doublePrecision(),
    humanizeWriting: boolean(),
    veoModel: text(),
    veoResolution: text(),
    veoAspectRatio: text(),
    veoDurationSeconds: integer(),
    veoGenerateAudio: boolean(),
    veoEnhancePrompt: boolean(),
    veoPersonGeneration: text(),
    veoNumberOfVideos: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("settings_user_idx").on(t.userId),
    index("settings_auto_publish_idx").on(t.autoPublishNextAt).where(sql`auto_publish_enabled`),
    check("settings_auto_privacy_chk", inList("auto_publish_privacy", PRIVACY_STATUSES)),
  ],
);

// ─── generations ─────────────────────────────────────────────────────────────
export const generations = pgTable(
  "generations",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    videoId: uuid().notNull().references(() => videos.id, { onDelete: "cascade" }),
    model: text().notNull(),
    prompt: text().notNull(),
    negativePrompt: text(),
    resolution: text().notNull(),
    aspectRatio: text().notNull(),
    durationSeconds: integer().notNull(),
    generateAudio: boolean().notNull(),
    status: text({ enum: GENERATION_STATUSES }).notNull().default("submitted"),
    veoOperationName: text(),
    outputVideoUrl: text(),
    thumbnailUrl: text(),
    error: text(),
    generationTimeMs: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("generations_user_idx").on(t.userId, t.createdAt),
    index("generations_video_idx").on(t.videoId),
    check("generations_status_chk", inList("status", GENERATION_STATUSES)),
  ],
);

// ─── notifications ───────────────────────────────────────────────────────────
export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    message: text().notNull(),
    type: text({ enum: NOTIFICATION_TYPES }).notNull(),
    isRead: boolean().notNull().default(false),
    link: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.createdAt),
    index("notifications_unread_idx").on(t.userId).where(sql`not is_read`),
    check("notifications_type_chk", inList("type", NOTIFICATION_TYPES)),
  ],
);

// ─── analytics ───────────────────────────────────────────────────────────────
/** Per-fetch snapshot of lifetime metrics (one row per video per UTC day). */
export const videoAnalytics = pgTable(
  "video_analytics",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    videoId: uuid().notNull().references(() => videos.id, { onDelete: "cascade" }),
    youtubeVideoId: text().notNull(),
    /** UTC calendar day of the snapshot. */
    day: date({ mode: "string" }).notNull(),
    fetchedAt: ts().notNull().defaultNow(),
    views: integer(),
    watchTimeMinutes: doublePrecision(),
    avgViewDurationSec: doublePrecision(),
    impressions: integer(),
    ctr: doublePrecision(),
    likes: integer(),
    comments: integer(),
    subscribersGained: integer(),
    estimatedRevenue: doublePrecision(),
    rpm: doublePrecision(),
    cpm: doublePrecision(),
    trafficSourceSearch: doublePrecision(),
    trafficSourceSuggested: doublePrecision(),
    trafficSourceExternal: doublePrecision(),
  },
  (t) => [
    uniqueIndex("video_analytics_video_day_idx").on(t.videoId, t.day),
    index("video_analytics_user_day_idx").on(t.userId, t.day),
    index("video_analytics_user_video_day_idx").on(t.userId, t.videoId, t.day),
  ],
);

/** Per-day metrics from the YouTube Reporting/Analytics API (deltas, not lifetime). */
export const videoDailyStats = pgTable(
  "video_daily_stats",
  {
    videoId: uuid().notNull().references(() => videos.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    day: date({ mode: "string" }).notNull(),
    views: integer().notNull().default(0),
    watchTimeMinutes: doublePrecision().notNull().default(0),
    avgViewDurationSec: doublePrecision(),
    likes: integer().notNull().default(0),
    comments: integer().notNull().default(0),
    subscribersGained: integer().notNull().default(0),
    subscribersLost: integer().notNull().default(0),
    impressions: integer(),
    ctr: doublePrecision(),
    estimatedRevenue: doublePrecision(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("video_daily_stats_pk").on(t.videoId, t.day),
    index("video_daily_stats_user_day_idx").on(t.userId, t.day),
  ],
);

export const youtubeQuotaUsage = pgTable(
  "youtube_quota_usage",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    date: date({ mode: "string" }).notNull(),
    unitsUsed: integer().notNull().default(0),
  },
  (t) => [uniqueIndex("youtube_quota_user_date_idx").on(t.userId, t.date), index("youtube_quota_date_idx").on(t.date)],
);

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    /** "YYYY-MM" */
    month: text().notNull(),
    videosUploaded: integer().notNull().default(0),
    metadataGenerated: integer().notNull().default(0),
    veoGenerated: integer().notNull().default(0),
    aiMessagesUsed: integer().notNull().default(0),
  },
  (t) => [uniqueIndex("usage_ledger_user_month_idx").on(t.userId, t.month)],
);

// ─── ideas / AI assistant ────────────────────────────────────────────────────
export const ideas = pgTable(
  "ideas",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    notes: text(),
    tags: text().array(),
    status: text({ enum: IDEA_STATUSES }).notNull().default("concept"),
    scheduledGenerateAt: ts(),
    linkedVideoId: uuid().references(() => videos.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ideas_user_idx").on(t.userId, t.createdAt),
    check("ideas_status_chk", inList("status", IDEA_STATUSES)),
  ],
);

export const aiSessions = pgTable(
  "ai_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text(),
    lastMessageAt: ts().notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_sessions_user_idx").on(t.userId, t.lastMessageAt)],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    sessionId: uuid().references(() => aiSessions.id, { onDelete: "cascade" }),
    role: text({ enum: AI_ROLES }).notNull(),
    content: text().notNull(),
    toolCalls: jsonb(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_messages_session_idx").on(t.sessionId, t.createdAt),
    index("ai_messages_user_idx").on(t.userId),
    check("ai_messages_role_chk", inList("role", AI_ROLES)),
  ],
);

// ─── platform-level ──────────────────────────────────────────────────────────
/** Singleton row (id = 1). All secrets encrypted. */
export const platformSettings = pgTable(
  "platform_settings",
  {
    id: smallint().primaryKey().default(1),
    deepseekApiKey: text(),
    geminiApiKey: text(),
    pesapalConsumerKey: text(),
    pesapalConsumerSecret: text(),
    pesapalEnvironment: text({ enum: ["sandbox", "live"] as const }).default("sandbox"),
    /** Registered IPN id returned by Pesapal RegisterIPN. */
    pesapalIpnId: text(),
    pesapalIpnUrl: text(),
    updatedAt: updatedAt(),
  },
  () => [check("platform_settings_singleton_chk", sql`id = 1`)],
);

export const contactSubmissions = pgTable(
  "contact_submissions",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    email: text().notNull(),
    subject: text().notNull(),
    message: text().notNull(),
    status: text({ enum: CONTACT_STATUSES }).notNull().default("new"),
    createdAt: createdAt(),
  },
  (t) => [
    index("contact_submissions_status_idx").on(t.status, t.createdAt),
    check("contact_status_chk", inList("status", CONTACT_STATUSES)),
  ],
);

// ─── billing (provider-agnostic core; Pesapal adapter) ───────────────────────
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    plan: text({ enum: ["pro", "elite"] as const }).notNull(),
    status: text({ enum: SUBSCRIPTION_STATUSES }).notNull().default("approval_pending"),
    provider: text({ enum: PAYMENT_PROVIDERS }).notNull().default("pesapal"),
    periodStart: ts(),
    periodEnd: ts(),
    /** Access continues until this instant after a missed renewal. */
    graceUntil: ts(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    /** Downgrade target applied at period end. */
    pendingPlan: text({ enum: PLANS }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("subscriptions_user_idx").on(t.userId, t.createdAt),
    // One live subscription per user.
    uniqueIndex("subscriptions_one_live_idx")
      .on(t.userId)
      .where(sql`status in ('approval_pending', 'active', 'past_due')`),
    index("subscriptions_period_end_idx").on(t.periodEnd).where(sql`status in ('active', 'past_due')`),
    check("subscriptions_status_chk", inList("status", SUBSCRIPTION_STATUSES)),
    check("subscriptions_plan_chk", inList("plan", ["pro", "elite"])),
  ],
);

export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    subscriptionId: uuid().references(() => subscriptions.id, { onDelete: "set null" }),
    provider: text({ enum: PAYMENT_PROVIDERS }).notNull().default("pesapal"),
    /** Our unique order id sent as Pesapal `id` (<= 50 chars). */
    merchantRef: text().notNull(),
    orderTrackingId: text(),
    purpose: text({ enum: PAYMENT_PURPOSES }).notNull(),
    plan: text({ enum: ["pro", "elite"] as const }).notNull(),
    amount: numeric({ precision: 12, scale: 2 }).notNull(),
    currency: text().notNull(),
    /** Pesapal status_code: 0 invalid/pending, 1 completed, 2 failed, 3 reversed. */
    statusCode: smallint(),
    statusText: text(),
    confirmationCode: text(),
    paymentMethod: text(),
    redirectUrl: text(),
    /** Set exactly once when a COMPLETED payment has been applied to the subscription. */
    appliedAt: ts(),
    /**
     * Flagged payments (amount mismatch, stale upgrade, reversal) need a human. An admin sets these once
     * the payment has been dealt with (e.g. refunded in the Pesapal dashboard). Null = not reviewed yet.
     */
    reviewedAt: ts(),
    reviewedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    reviewNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payment_orders_merchant_ref_idx").on(t.merchantRef),
    uniqueIndex("payment_orders_tracking_idx").on(t.orderTrackingId).where(sql`order_tracking_id is not null`),
    index("payment_orders_user_idx").on(t.userId, t.createdAt),
    // The admin "needs review" queue: flagged and not yet reviewed.
    index("payment_orders_needs_review_idx")
      .on(t.createdAt)
      .where(sql`reviewed_at is null and (status_text in ('AMOUNT_MISMATCH', 'STALE_UPGRADE') or status_code = 3)`),
    check("payment_orders_purpose_chk", inList("purpose", PAYMENT_PURPOSES)),
  ],
);

/** Raw provider notifications for audit and replay; processing is idempotent elsewhere. */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: text({ enum: PAYMENT_PROVIDERS }).notNull().default("pesapal"),
    orderTrackingId: text(),
    merchantRef: text(),
    notificationType: text(),
    payload: jsonb().notNull(),
    receivedAt: ts().notNull().defaultNow(),
    processedAt: ts(),
    error: text(),
  },
  (t) => [index("payment_events_tracking_idx").on(t.orderTrackingId, t.receivedAt)],
);
