# Reelcast — Product Roadmap & Feature Specification

> Internal working document. Covers current state, planned features, architecture evolution, and long-term vision.
> Last updated: October 2026
>
> Status markers used below: **Built** (works in the code today), **Partially built** (a usable core exists, the remaining gap is named), **Not started**. Technical statements are checked against the code; file paths point at where each feature lives.

---

## 1. Vision & Mission

**Mission:** Give every YouTube creator, team, and agency the infrastructure to publish consistently, intelligently, and at scale — without the operational overhead.

**Vision:** Reelcast becomes the operating system for YouTube content operations. Not just a scheduler — a full publishing workflow platform that combines AI, automation, collaboration, and analytics into one system creators actually live inside.

**Core insight:** The bottleneck for most YouTube channels is not ideas or even production — it is the repetitive operational work between "video exists" and "video is live and performing." Reelcast eliminates that gap.

---

## 2. Current State (What Is Built)

This section captures what exists and works today. Every feature below is implemented in code. Pages live in `src/app/(app)/`, server functions in `src/server/modules/`, and background work in `src/server/jobs/handlers/` and `src/server/lib/`.

### 2.1 Video Management
- Multi-file drag-and-drop upload straight from the browser to Cloudinary with per-file progress. The upload is signed by `/api/cloudinary/sign`, which also enforces the plan's maximum file size
- Auto-generate on upload: after each upload the page requests AI metadata unless the user has explicitly turned auto-generate off (an unset setting counts as on)
- Video library (`/drafts`, shown as "Library") with search, status filter pills and six sort options (newest, oldest, name A–Z/Z–A, size)
- Video detail page (`/video/[id]`) with inline player, AI metadata, metadata version history (last 10), publish controls, analytics and delete
- Publish-as toggle (Short vs. long-form video): the publisher strips `#Shorts` from the description for long-form uploads
- Privacy selector (private / public / unlisted) per video
- Bulk operations in the library: mark every draft that has a file as ready, and switch videos longer than 60 seconds to "video" type (a duration backfill from Cloudinary runs first for videos with no stored duration)
- Post-publish storage cleanup: once YouTube confirms the upload, the Cloudinary files are destroyed (best effort) and the video is stamped with `cloudinary_deleted_at`
- Video delete removes the Cloudinary assets (best effort) and then the rows
- Storage health: queue and auto-publish check that the source file still exists (HEAD request) and flag videos whose file is missing so they are skipped

### 2.2 Publishing Pipeline
- **Publish now** from the video detail page or the queue
- **Single-video scheduling** from the video detail page or `/schedule`: the video gets a `scheduled_publish_at`, and the `publish.dueSchedules` sweep (every minute) turns due rows into publish jobs
- **Auto-publish batches**: configurable timezone, interval, posting time slots, videos per run (1–50) and privacy. Each run is an `autoPublish.run` task that claims ready videos in queue order, enqueues their publish jobs, and then reschedules itself, so the chain survives errors
- YouTube **resumable upload** streamed from Cloudinary in 16 MiB chunks across job runs, so files up to 2 GB survive the host's function time limit
- Access tokens refresh automatically when less than 5 minutes remain (`src/server/lib/youtube/tokens.ts`)
- Retries use the queue's exponential backoff: with the default 3 attempts a failing job is retried twice (after 30 s, then 60 s; the delay doubles up to 15 minutes for jobs allowed more attempts); failures notify the user
- `publish.reconcile` (every 5 minutes) repairs videos stuck in "publishing"
- Job history page (`/history`) with a retry button for failed jobs and a Generations tab for Veo runs
- Daily YouTube API quota is counted per user in `youtube_quota_usage` (an upload costs 1,600 units)

### 2.3 AI Metadata, Thumbnails and Captions
- Gemini 2.5 Flash frame analysis: 3 frames (start, 25%, 75%) are pulled from Cloudinary with URL transforms and sent to Gemini with a VidIQ-style SEO prompt
- Outputs: title (≤55 chars, curiosity-gap), description (4-line: snippet + gain + CTA + hashtags), 12–15 tiered tags
- Personalised by the user's tone and custom guidelines; optional "humanize writing" rules
- Scheduled metadata generation: a draft can be queued to get metadata at a future time (a `metadata.generate` task), with an auto-mark-ready option
- Regenerate metadata on demand from the video detail page; the Generate page also has a bulk "Generate Metadata" tab (select videos, run sequentially, mark successes ready)
- When Gemini's Files API would be needed (frame extraction unavailable) the work is handed to the task queue and the call returns immediately
- AI thumbnail picker: Gemini chooses the best of five candidate frames and the result is stored as a Cloudinary transform URL (`thumbnail_generated_url`)
- AI captions: frames are transcribed into a WebVTT track stored on the video (`captions_vtt`)
- Metadata generation is metered per month (see section 7)

### 2.4 AI Video Generation (Veo)
- Six models: Veo 3.1 Preview (recommended), Veo 3, Veo 3.1 Fast Preview, Veo 3 Fast, Veo 3.1 Lite Preview, Veo 2
- Config: prompt, negative prompt, resolution (720p / 1080p), aspect ratio (16:9 / 9:16 / 1:1), duration (4 / 6 / 8 s), prompt enhancement, audio (audio is produced only on Vertex AI)
- Runs as a resumable `generation` job: submit, poll every 15 s or longer (10-minute wall-clock cap), stream the output into Cloudinary, mark the video ready, then generate metadata from the prompt
- **Credentials are platform-managed**, not BYOK: an admin stores a Gemini API key in Admin → Settings (encrypted), with `GEMINI_API_KEY` as a fallback, and Vertex AI is used when a service account is configured in the environment
- **Plan-gated**: a monthly Veo allowance per plan (Free 0, Pro 5, Elite unlimited). The unit is consumed at submit and refunded only if the submit itself fails
- Full details, state machine and known gaps: `docs/VEO-INTEGRATION-PLAN.md`

### 2.5 Notifications
- **In-app bell**: the 50 most recent notifications per user in the `notifications` table, with mark read / mark all read / clear all
- **Discord**: a webhook URL per user (validated against Discord's own hosts)
- **Telegram**: the platform's bot token (`TELEGRAM_BOT_TOKEN`) plus a chat ID per user
- **Email**: bring-your-own Resend key (stored encrypted) with an optional from-address; silently skipped when not configured
- Per-event toggles: publish success, publish failure, metadata ready (also used for "video generated"), weekly digest, storage warning. An unset toggle counts as off
- Message templates with `{{title}}` / `{{url}}` for the publish-success message (Discord and Telegram)
- **Weekly digest**: the `weekly-digest` sweep opens a Sunday 08:00–08:59 UTC window once per ISO week and a `digest.batch` task sends each opted-in user their publish count, views and top video, at most once per user per week
- Master enable switch, test-send buttons for each channel, and per-channel settings pages under `/settings`

### 2.6 Analytics
- Dashboard stats from the database: status distribution, upload timeline for the last 7 days, total videos, storage bytes, total duration, live countdown to the next auto-publish and an estimated publish time per queued video
- **YouTube Analytics ingestion** (YouTube Analytics API, `src/server/lib/analytics/`):
  - `video_analytics`: a lifetime snapshot per video per UTC day (views, watch time, average view duration, likes, comments, subscribers gained), written by the "Refresh from YouTube" action (up to 50 most recent published videos per refresh)
  - `video_daily_stats`: per-day deltas ingested by the `analytics.dailyIngest` sweep every 6 hours in resumable `analytics.ingestChunk` tasks (rolling 7-day window, idempotent)
- `/analytics` shows channel totals, a performance time series and a per-video metrics list; the video detail page shows views, watch time, likes and comments for published videos
- Suggested posting times: the three best publish hours from the user's own history (`scheduling.getSuggestedTimes`), ranked by average views
- Impressions and CTR are not fetched by anything (they are Studio-only metrics), and revenue, retention and traffic-source data are not requested; the matching columns in `video_analytics` stay empty
- Optional product analytics with PostHog (`NEXT_PUBLIC_POSTHOG_KEY`; EU host by default, internal user id only, no session recording)

### 2.7 Scheduling, Queue and Calendar
- `/schedule`: single-video scheduling, scheduled-metadata queue, auto-publish configuration, suggested times and a compact week strip with a link to the full calendar
- `/queue`: ready and scheduled videos in `publish_order`, thumbnails, **Publish Now** per row, up/down arrows to reorder (the drag handle is decorative), a storage-health check, queue stats and the time of the next auto-publish run
- `/content-calendar`: read-only calendar of scheduled and auto-publish slots with year, month, week and day views and a day panel with details

### 2.8 AI Assistant, Content Intelligence and Ideas
- **AI Assistant**: a slide-out chat panel backed by DeepSeek (`deepseek-chat`). Each turn gets a system prompt with a snapshot of the user's data (status counts, ten recent videos, recent analytics, auto-publish settings, tone, niche, audience and brand voice). Sessions and messages are stored in `ai_sessions` / `ai_messages`. A per-user DeepSeek key, if one is stored, wins over the platform key (no settings field collects it yet, so in practice the platform key from Admin → Settings is used). Free plan has no access; Pro gets 200 messages and Elite 1,000 per month, and an unanswered turn is refunded. The assistant answers questions; it does **not** call tools or change data yet (see 4.8)
- **Content Intelligence** (`/intelligence`): trending videos (YouTube "most popular" chart), keyword search, and content-gap analysis (trending tags the user has not covered; the server can also compare up to five competitor channels' recent titles, but the UI does not collect competitor channels yet). YouTube quota use is recorded
- **Idea Vault** (`/ideas`): create ideas, filter and move them between statuses (concept / in production / published), delete, with an optional planned generate date

### 2.9 YouTube Channels and OAuth Health
- Connect through `/api/youtube/connect` and `/api/youtube/callback`; tokens are stored encrypted and never reach the browser
- Multiple channels per account are supported: `/settings/youtube` lists them, sets the primary channel, disconnects, and reconnects. The Free plan is limited to one channel; paid plans have no channel cap in code. A YouTube channel can be linked to only one Reelcast account
- Health: each channel has an `oauth_status` (`connected`, `token_expired`, `revoked`, `unknown`). The `oauth.health` sweep probes all channels every 6 hours and a "Check health" button does it on demand. A token refresh that fails marks the channel `token_expired`, and Google answering `invalid_grant` marks it `revoked` (publish jobs then stop retrying and the user's YouTube analytics are purged); a 401 in content-intelligence calls also marks it expired. The user gets a one-time in-app notification when a channel becomes revoked. The status shows as a badge with a Reconnect button, and admins see token health in Admin → Health

### 2.10 Admin Dashboard
Admin-only routes under `/admin` (access is re-checked from `users.is_admin` in the database on every call):
- **Overview**: total users, users with a connected channel, videos, storage, jobs today, 24-hour publish success rate, active auto-publish configurations, recent failures, and broadcast notifications to all users
- **Users** (with per-user detail, admin toggle and plan assignment), **Videos** (with admin delete), **Jobs** (recent and failed), **Usage** (per-month metering against plan limits), **Storage** (per-user breakdown), **YouTube quota** (today's usage per user), **Health** (token and storage health), **Contact** submissions
- **Platform settings**: Gemini and DeepSeek keys and the Pesapal credentials (all encrypted), connection tests, and IPN registration

### 2.11 Billing and Plans
- Three plans: Free, Pro, Elite, with monthly usage metering and per-plan limits (see section 7)
- Payments through Pesapal (hosted checkout, M-Pesa, Airtel Money and cards); `/billing` shows the plan, usage meters, renewal state and payment history (details in section 7)

### 2.12 Settings & Configuration
- A main settings page plus sub-pages: YouTube, Telegram, Notifications, General, AI (`/settings/*`), and `/ai-config` for metadata defaults
- AI defaults: auto-generate toggle, per-field toggles (title / description / tags), tone, language, description length, custom guidelines, humanize writing
- Brand memory: niche, target audience, brand voice, forbidden words, CTA preferences (stored; see 4.8 for what consumes them)
- Veo defaults: model, resolution, aspect ratio, duration, prompt enhancement
- Auto-publish defaults: timezone, interval, count, privacy, time slots
- **Per-user keys (encrypted)**: Resend (email) has a settings field; a per-user DeepSeek key is supported by the server but has no settings field yet. Gemini/Veo keys are platform-level (Admin → Settings)
- The AI and Veo defaults can be edited in three places: `/settings/ai`, the AI settings modal opened from `/settings`, and (metadata only) `/ai-config`

### 2.13 Infrastructure
- Next.js 16 (App Router), React 19, TypeScript, Tailwind 4; bun for installs and scripts
- Auth: Supabase Auth (email/password and Google). The app user row (`users.id` = the Supabase auth user id) is created on the first request
- Database: Supabase Postgres through Drizzle ORM; schema in `src/db/schema.ts`, SQL migrations in `drizzle/`. Every table has row-level security enabled with no policies and no grants to the `anon` / `authenticated` roles, so only the server's database role can read or write; each server function additionally filters by the signed-in user's id
- Client ↔ server: a typed RPC layer. The browser calls `POST /api/rpc` and the registry dispatches to `query` / `mutation` / `action` functions in `src/server/modules/`, with `user`, `admin` and `public` auth levels. There is no real-time push: writes invalidate cached queries and the queries that matter (jobs, videos, queue, notifications, billing) poll
- Background work: a portable Postgres job queue in `src/server/jobs/` (`jobs`, `tasks`, `job_schedules`). In production Supabase pg_cron calls `GET /api/cron/tick` every minute; in development `src/instrumentation.ts` runs the tick every 5 seconds, so `next dev` is the only process. Handlers are idempotent because delivery is at-least-once
- Storage: Cloudinary (signed direct browser uploads; Veo outputs are copied in; files are deleted after publishing)
- Secrets (YouTube tokens, BYOK keys, platform keys, Pesapal credentials) are AES-256-GCM encrypted with `APP_ENCRYPTION_KEY` and never returned to the browser
- Protected routes are served with `Cache-Control: no-store` from `src/middleware.ts` so back/forward navigation does not restore stale authenticated pages

---

## 3. Immediate Completions (v1.1) — Close the Gaps

These were the partially built or blocked features identified for v1.1. Most have shipped; the status of each is below, with what remains.

### 3.1 Auto-Generate on Upload
**Status: Built.**
**Original gap:** the `ai_auto_generate` setting was stored but never read by the upload flow.
**Shipped:** after `videos.create` succeeds, the upload page calls `actions.metadata.generateForUpload` unless the setting is explicitly `false`. Because new users have no value yet, an unset setting is treated as on by the upload page, the post-Veo metadata step and the settings screens.

### 3.2 Schedule Button on Video Detail Page
**Status: Built.**
**Shipped:** the video detail page has an inline date-time picker that calls `videos.schedulePublish`; the user does not have to go to `/schedule` for single-video scheduling.

### 3.3 Thumbnail System
**Status: Partially built.**
**Shipped:**
- Veo-generated videos get a poster frame saved to `videos.thumbnail_url` and `generations.thumbnail_url` when the generation completes
- Uploaded videos get a Cloudinary-transform poster computed at render time in the library video card (nothing is stored)
- An "AI thumbnail" action lets Gemini choose the best frame and stores the transform URL in `thumbnail_generated_url`
**Remaining:** persist a thumbnail for uploaded videos at upload time (a Cloudinary `/so_0/w_400/q_auto/f_jpg/` URL) so every list and the publish notifications use the same stored image, and decide whether the generated thumbnail should be pushed to YouTube at publish time (not done today).

### 3.4 Generations History Page
**Status: Built.** The History page has a Generations tab backed by `generations.listByUser`, showing prompt, model, status, generation time and a link to the video.

### 3.5 Complete Settings Sub-Pages
**Status: Built (navigation still to tidy).** `/settings/youtube`, `/settings/telegram`, `/settings/notifications`, `/settings/general` and `/settings/ai` are real pages, no longer "Coming soon". The main `/settings` page was not turned into a navigation hub: it still carries its own YouTube, Telegram and Discord cards and an AI settings modal, and links to only some of the sub-pages. The YouTube OAuth callback returns to `/settings?youtube=connected|error` with a status banner rather than to `/settings/youtube`.
**Remaining:** cards on the settings page linking to every sub-page, and redirecting the OAuth callback to `/settings/youtube`.

### 3.6 Email Notifications (BYOK — Resend)
**Status: Built.**
**Model:** bring your own key. The user creates a Resend account and pastes an API key (plus an optional from-address) into Notifications settings. The key is stored encrypted in `settings.resend_api_key` and used server-side to send mail from the user's own Resend account; Reelcast holds no shared Resend account.
**Templates shipped:** publish success (with link and thumbnail), publish failure (with error), metadata ready, video generated, metadata failed, storage warning, weekly digest.
**Fallback:** with no key configured (or email notifications switched off), email is skipped silently.

### 3.7 Backfill `ai_auto_generate` Settings Default
**Status: Resolved without a data migration.** The column stays nullable. The upload page and the post-Veo metadata step treat null as "on", and `/settings/ai`, `/ai-config` and the settings modal render the toggle as on, so there is no indeterminate state. Only an explicit `false` turns auto-generation off.

---

## 4. Core Platform Enhancements (v1.2)

### 4.1 YouTube Analytics Integration
**Status: Partially built.**
**Shipped:** analytics are pulled from the YouTube Analytics API using the connected channel's OAuth token, stored in Postgres, and shown in the app (see 2.6). Instead of a short-lived cache, data is persisted per UTC day and refreshed on demand (up to 50 videos per refresh, bounded in time) and by a 6-hourly background ingest that respects the daily YouTube quota.

**Data model (existing tables):**
```
video_analytics        one row per (video_id, day): youtube_video_id, fetched_at,
                       views, watch_time_minutes, avg_view_duration_sec, likes, comments,
                       subscribers_gained            -- lifetime snapshot at fetch time
                       (impressions, ctr, estimated_revenue, rpm, cpm, traffic_source_* exist
                        as columns but nothing populates them)
video_daily_stats      one row per (video_id, day): views, watch_time_minutes, avg_view_duration_sec,
                       likes, comments, subscribers_gained, subscribers_lost
                       -- per-day deltas
```

**Remaining:**
- Impressions and CTR (not available from the Analytics API reports used today)
- Revenue and other monetary metrics (need a different OAuth scope)
- A dashboard "Performance" section with top videos and a subscriber-growth chart (the `/analytics` page covers channel totals and a time series)

### 4.2 OAuth Health Dashboard
**Status: Mostly built.**
**Shipped:** per-channel `oauth_status` (`connected | token_expired | revoked | unknown`), a 6-hourly health sweep that probes `channels?mine=true`, an on-demand check, status updates on failed refreshes and on 401s from content-intelligence calls, a one-time notification when a channel becomes revoked, status badges with a Reconnect button, and an admin health view.
**Remaining:** a global alert banner on the dashboard and the video detail page when a channel is unhealthy (the status currently shows only in settings and admin), and a "Re-authorise" action that keeps existing tokens until the new grant succeeds (Reconnect re-runs the OAuth flow and keeps the stored refresh token if Google does not issue a new one).

### 4.3 Bulk Metadata Operations
**Status: Partially built.**
**Shipped:** the Generate page's "Generate Metadata" tab selects many videos, runs generation sequentially and marks the successes ready; the library has "Mark all Ready" and a bulk type switch; scheduled metadata generation exists per video (`videos.scheduleMetadataForVideo`).
**Remaining (spec):**
- In the library (`/drafts`): checkbox multi-select mode
- A bulk actions toolbar: "Generate Metadata", "Mark Ready", "Schedule Metadata For", "Delete"
- Bulk schedule: pick a start datetime and gap interval; assign each selected video a `metadata_scheduled_at` in sequence
- Bulk delete with Cloudinary cleanup (run the existing `deleteVideo` action per video)

### 4.4 Content Calendar
**Status: Partially built.**
**Shipped:** a compact week strip on `/schedule` linking to `/content-calendar`, which has year, month, week and day views with events colour-coded by type (published, manually scheduled, auto-publish slot) and a day detail panel (thumbnail, title, time, link to the YouTube video).
**Remaining (spec):**
- Drag-and-drop of videos from a ready-pool sidebar onto calendar time slots; dropping calls `videos.schedulePublish` for that datetime
- Removing a schedule directly from the calendar (`videos.cancelSchedule`, which reverts the video to ready)

### 4.5 Publish Queue
**Status: Built (reordering with arrows).**
**Shipped:** `/queue` lists ready and scheduled videos in publish order with thumbnails, a **Publish Now** button per row (`actions.publishNow`, bypassing the schedule), up/down reordering stored in `videos.publish_order` via `queue.bulkSetPublishOrder`, a storage-health check, and a banner for the next auto-publish run (or a notice that auto-publish is off). Estimated publish times for ready videos appear on library cards and the video detail page.
**Remaining:** true drag-to-reorder (the drag handle is visual only) and an estimated publish datetime on every queue row.

### 4.6 Advanced Notification Rules
**Status: Partially built.**
**Shipped:** per-event toggles (publish success, publish failure, metadata ready, weekly digest, storage warning), custom message templates for the publish-success message, and the weekly digest.
**Remaining (spec):**
- Custom templates for the other events
- Discord rich embeds: instead of `{ content: message }`, send a proper embed with thumbnail, title, YouTube link and success/failure colour (today the webhook posts plain content)
- Telegram inline keyboard with a "View on YouTube" button (today plain text)

### 4.7 Storage Management Page
**Status: Partially built.**
**Shipped:** admins get a per-user storage breakdown; users get missing-file detection on the queue (HEAD checks that flag videos whose files are gone) and an automatic Cloudinary cleanup after publishing. A "storage warning" notification fires when auto-publish finds ready videos whose files are gone and skips them.
**Remaining (spec):** a user-facing `/settings/storage` page listing all videos with `raw_file_size`, sorted by size, "Cleaned" / "Cleanup failed" badges (from `cloudinary_deleted_at`) and a manual cleanup/retry button for published videos whose files were not deleted.

### 4.8 AI Assistant
An embedded AI that understands the user's content library, publishing schedule, and database-level analytics and accepts natural-language commands.

**Status: Partially built — conversational assistant shipped, tool-use actions not started.**

**AI provider: DeepSeek (`deepseek-chat`).** DeepSeek does not process video frames or images. All context is constructed from structured database data: video records (title, tags, status), publishing settings, analytics rows (views and, once available, CTR) and the user's brand settings. The assistant never sees the video file.

**What is built:**
- A chat panel (`src/components/ai/assistant-panel.tsx`) with persistent sessions per user (`ai_sessions`, `ai_messages`) and follow-up questions
- The `aiAssistant.chat` action: checks the plan, resolves the key (the user's own DeepSeek key, else the platform key), meters one message against `ai_messages_used` atomically, builds a system prompt with a context snapshot (counts by status, ten recent videos with tags, the most recent analytics rows, auto-publish state, tone, niche, target audience, brand voice), calls DeepSeek and stores both sides of the turn
- Plan gating: Free has no access, Pro 200 messages per month, Elite 1,000. Near the limit the assistant appends a remaining-messages note

**Capabilities (target):**

*Metadata operations:*
- "Regenerate the metadata for all my draft videos from this week"
- "Change the tone of all unscheduled videos to 'casual'"
- "Add #fitness and #motivation to all videos tagged with #workout"
- "Find all videos without a description and fill them"

*Scheduling operations:*
- "Schedule everything in my ready queue for the next two weeks at noon EAT daily"
- "Reschedule all videos that failed to publish last week"
- "Pause auto-publish for the next 3 days"
- "What's my publishing schedule for this month?"

*Analytics & intelligence (from the database):*
- "Which of my published videos got the most views this week?"
- "What content format is performing best — Shorts or long-form?"
- "How many videos did I publish last month?"
- "Show me videos with high impressions but low CTR" (needs impressions and CTR data first, see 4.1)

*Content discovery:*
- "What are the trending topics in [niche] right now?"
- "Suggest 5 video ideas based on my top performers"
- "What gaps exist in my content calendar?"

Today the assistant can discuss these topics from its context snapshot, but it cannot execute them.

**Implementation architecture for actions (future):**

*Processing pipeline:*
1. User message goes to DeepSeek with the context snapshot above and a list of tool definitions
2. DeepSeek selects which tool(s) to call using function calling
3. The server executes each tool through the same module and library functions the UI uses (so ownership checks, validation and plan metering all apply), scoped to the caller's `user_id`, and returns structured results to the model
4. Destructive or bulk actions (delete, reschedule many) require an explicit confirmation step before they run
5. DeepSeek formats the final response with the data and any action confirmations

*Tool schema:*
```
listVideos(status?, limit?, createdAfter?) → VideoSummary[]            ~ videos.list
updateVideoMetadata(videoId, title?, description?, tags?) → void       = videos.updateMetadata (exists; the editor saves manual edits)
scheduleVideo(videoId, publishAt, privacy?) → void                     ~ videos.schedulePublish
bulkScheduleVideos(videoIds, startAt, intervalMs) → void               new, loops schedulePublish
getAnalytics(period, metric) → AnalyticsData                           ~ videoAnalytics.* queries
generateMetadata(videoId) → AIMetadata                                 ~ actions.metadata.generateForUpload
searchVideos(query) → VideoSummary[]                                   new
getPublishQueue() → QueueItem[]                                        ~ queue.list
saveIdea(title, notes) → void                                          ~ ideas.create
```

*UI:* floating chat panel (slide-in from a topbar button), persistent history, and a "thinking" indicator while tools run.

**Brand Memory:**
- The user defines channel identity: niche, target audience, brand voice, forbidden words, CTA preferences. These are stored as structured columns in `settings` (`ai_niche`, `ai_target_audience`, `ai_brand_voice`, `ai_forbidden_words`, `ai_cta_preferences`) next to the free-text `ai_guidelines`
- Today the assistant prompt receives tone, niche, audience and brand voice; metadata generation uses guidelines, tone and the humanize option. Forbidden words and CTA preferences are stored but not yet injected anywhere
- Remaining: inject every brand field into both the assistant prompt and the metadata prompts

### 4.9 Content Intelligence
Surfaces actionable insights about what's performing and what to create next.

**Status: Partially built.**

**Trending Topics — Built (basic):**
- Data sources: the YouTube Data API "most popular" chart and keyword search; the `/intelligence` page shows trending videos and keyword results
- Remaining: search-volume trend (7 days), top video examples per keyword card, an estimated competition level, and a "Create video on this topic" button that pre-fills the Veo prompt or creates a draft with suggested metadata

**Opportunity Score — Not started:**
- Per-topic score (1–100): search volume trend × (1 / competition) × alignment with the user's content history (derived from published video tags), shown as a colour-coded badge on each topic card
- Would be refreshed daily by a sweep in the job queue. No scoring function exists yet

**Content Gap Analysis — Partially built:**
- Built: `contentIntelligence.getContentGaps` compares the tags on the user's published videos with the tags of trending videos and returns the trending tags the user has not covered
- Competitor comparison: the action can also fetch recent titles from up to five competitor channels (`competitorChannelIds`), and `settings.competitor_channel_ids` can store them, but no settings field collects them and the page does not pass them, so the "Your competitors are on this — you aren't" panel is not live
- Remaining: a settings field for competitor channel URLs/ids, passing them to the action, and topic-level coverage counts

**Idea Vault — Partially built:**
- Built: `/ideas` lists ideas with status (concept / in production / published), filters, edit and delete, and an optional planned generate date (`scheduled_generate_at`)
- Remaining: converting an idea to a Veo generation or a draft in one click (the "Link to Video" button is a placeholder), acting on the planned generate date (nothing schedules a generation from it yet), and the AI assistant saving ideas ("Save this to my idea vault"), which depends on the tool layer in 4.8

**Performance Prediction — Not started:**
- DeepSeek predicts expected CTR and view velocity from title + tag combination, using the user's own past publish data as examples in the prompt (no image analysis needed)
- Shown as a "predicted performance" indicator on the metadata editor before publishing
- A/B title testing: generate 3 title variants, the user picks one, and the system tracks which performed best (requires CTR data from 4.1)

### 4.10 Advanced Analytics
Builds on the v1.2 YouTube Analytics foundation with deeper per-video and channel-level insight.

**Status: Not started** (apart from suggested posting times and the weekly digest noted below).

**Deeper YouTube Analytics:**
- Revenue tracking (monetised channels): estimated revenue per video, RPM, CPM (needs the monetary OAuth scope; the `estimated_revenue`, `rpm` and `cpm` columns already exist)
- Audience retention curves: per-video watch-time graph (where viewers drop off) from the YouTube Analytics API, rendered as a line chart on the video detail page (needs a new table for retention buckets)
- Traffic source breakdown: YouTube search vs. suggested vs. external per video (`traffic_source_*` columns exist but are not populated)
- Subscriber attribution: which videos gained the most subscribers (`subscribers_gained` is already stored per day)

**Publishing Performance Dashboard:**
- Best posting times: a first version exists as `scheduling.getSuggestedTimes` (top three publish hours by average views, with at least five published videos); extend it to views in the first 48 hours by hour and weekday once CTR data exists
- Format performance: Shorts vs. long-form view velocity comparison
- Metadata quality score: correlation between AI-generated metadata quality indicators and CTR
- Content series tracking: group related videos by tag, compare series performance

**Automated Reports:**
- Weekly digest: **Built.** Publish count, total views, top video, delivered through the user's enabled channels (Telegram, Discord, email via Resend) on Sunday 08:00 UTC by the `weekly-digest` sweep
- Remaining: subscriber change in the digest

### 4.11 Admin Dashboard
**Status: Built.** (Original spec below; remaining gaps are listed at the end.)

**What was specified:**
- `/admin` route, accessible only to users with `users.is_admin = true`
- **System health panel:** total registered users, total videos, jobs run today, active auto-publish configurations, publish success rate (24 h), failed jobs with links to their records
- **User table:** email, signup date, video and published counts, YouTube connection status, with a per-user detail page
- **YouTube API quota tracker:** units consumed per user today against the 10,000-unit daily figure, with a warning colour at 80%
- **Storage overview:** total storage and the per-user breakdown
- **Notification health:** Discord / Telegram success and failure rates (24 h)

**Gaps:** the 7-day success rate, "last active" and filter controls on the user table, a project-wide quota total, and the notification-health panel are not built.

---

## 5. Multi-Channel Support (v1.3)

**Status: Partially built.** Multiple YouTube channels per account are connected, stored and used by the publisher; the per-video and per-batch channel choice and the duplicate-publish guard are not built.

### 5.1 Data Model
Channels are rows in `youtube_channels` (one per connected YouTube channel); the `users` table holds no channel fields.

```
youtube_channels
  id (uuid), user_id → users
  channel_id (YouTube channel id, globally unique: one channel can be linked to one account)
  channel_name
  access_token, refresh_token      -- AES-256-GCM encrypted, never returned to the browser
  token_expiry
  oauth_status                     -- connected | token_expired | revoked | unknown
  is_primary                       -- at most one per user (partial unique index)
  created_at, updated_at

videos (existing column)
  youtube_channel_id (text)        -- the YouTube channel id of the target channel; NOT a foreign key.
                                      When null (or no longer connected) the publisher uses the primary channel
```

### 5.2 Channel Management UI
**Built.** `/settings/youtube` lists connected channels with per-channel status, connect / reconnect / disconnect, and "set as primary". The Free plan can connect one channel (`PLAN_LIMIT_EXCEEDED:youtubeChannels:free` otherwise). Removing a channel purges that user's YouTube-derived analytics.
**Remaining:** a `?channelHint=` parameter on `/api/youtube/connect` to steer users to the right Google account.

### 5.3 Per-Video Channel Selection
**Not started in the UI.** The publisher already honours `videos.youtube_channel_id` (`resolveChannelRow` in `src/server/lib/publish/run.ts`), but nothing sets it and the video detail page has no channel selector. Remaining: the selector on the video detail page (when more than one channel is connected) and a channel choice in the auto-publish settings (a `settings.auto_publish_channel_id` column).

### 5.4 Multi-Channel Publishing (Same Video)
> **Important:** Publishing the same video file to the same YouTube channel more than once violates YouTube's duplicate content policies and will result in the second upload being flagged or removed, and repeated violations can lead to account suspension.

**What Reelcast supports:**
- Publishing a video to **different channels** (e.g., an English channel and a Spanish channel) — each channel has its own upload, so these are distinct uploads on distinct accounts and are not flagged
- Publishing a **different version** of a video (different file, different edit) to the same channel

**What Reelcast will not do silently (not built yet):**
- If a user attempts to publish a video to a channel it has already been published to, the UI shows a warning: "This video has already been published to [channel name]. Re-uploading the same file to the same channel may violate YouTube's duplicate content policy. Are you sure?"
- The warning is a hard gate: the user must explicitly confirm before the second publish job is created
- Today a video that already has a YouTube id is never re-uploaded by the publish job; publishing the same file to a second channel would need a separate per-channel publication record (for example a `video_publications` table keyed by video and channel)

---

## 6. Organizations & Teams (v2.0)

**Status: Not started.** This is the largest architectural addition. It transforms Reelcast from a single-user tool into a collaboration platform for creator teams.

### 6.1 Core Concepts

**Organization:** The top-level entity. A company, creator brand, or team. All videos, channels, settings, and members belong to an organization. One user can belong to multiple organizations.

**Workspace:** An isolated environment within an organization. Used to separate channel verticals, project types, or clients. Videos and channels belong to a workspace.

**Member:** A user with a role within an organization or workspace.

### 6.2 Roles & Permissions (RBAC)

| Role | Capabilities |
|------|-------------|
| **Owner** | All actions including billing, member management, org deletion |
| **Admin** | All actions except billing and org deletion |
| **Publisher** | Upload, publish, manage own videos, view analytics |
| **Editor** | Upload, generate metadata, edit metadata, submit for review — cannot publish |
| **Reviewer** | View videos, approve or reject submissions — cannot upload or publish |
| **Viewer** | Read-only access to video library, analytics, and history |

### 6.3 Data Model Additions
New tables follow the existing conventions: uuid primary keys, `text` + CHECK constraints for enums, timestamptz columns, and RLS enabled with no policies (server-only access).

```
organizations
  id uuid pk, name, slug (unique), logo_url
  plan                          -- free | pro | elite (moves the entitlement from the user to the org)
  owner_id → users, created_at

workspaces
  id uuid pk, org_id → organizations, name, slug (unique per org), description
  -- channels attach via youtube_channels.workspace_id (replaces an array of channel ids)

org_members
  org_id → organizations, user_id → users          unique (org_id, user_id)
  role                          -- owner | admin | publisher | editor | reviewer | viewer
  status                        -- active | invited | suspended
  invited_by → users, joined_at
  indexes: (org_id), (user_id)

workspace_members
  workspace_id → workspaces, user_id → users       unique (workspace_id, user_id)
  role                          -- inherits the org role unless overridden
  indexes: (workspace_id), (user_id)

invitations
  id uuid pk, org_id → organizations, email, role
  token (hashed), expires_at, invited_by → users
  status                        -- pending | accepted | expired
```

All existing tenant-scoped tables (`videos`, `jobs`, `settings`, `notifications`, `ideas`, `youtube_channels`, `generations`, and the analytics tables) gain `org_id` and `workspace_id` columns plus the indexes in 8.3. Billing moves with the plan: `subscriptions` gains an `org_id` (the Pesapal flow is one-off orders per subscription, so no customer id is needed on the organization).

### 6.4 Approval Workflow

**Flow:**
1. Editor uploads a video and adds metadata → status: `awaiting_review`
2. Reviewer(s) receive an in-app notification and email: "New video ready for review"
3. Reviewer opens the video detail page, sees the full metadata, can play the video
4. Reviewer actions: **Approve** (transitions to `ready`), **Request Changes** (returns to `draft` with a comment), **Reject** (marks as `rejected`)
5. On approval, the video enters the publish queue per normal flow
6. Editor receives a notification of the decision with the reviewer's comment

**Data model:**
```
video_reviews
  id uuid pk, video_id → videos, reviewer_id → users
  decision                      -- approved | changes_requested | rejected
  comment, created_at

videos additions
  review_status                 -- none | awaiting | approved | rejected
  review_requested_at, review_completed_at
  requires_review boolean       -- copied from the workspace setting at upload
  (and the new video statuses awaiting_review / rejected added to VIDEO_STATUSES and its CHECK)
```

### 6.5 Activity Feed
- Per-workspace timeline of all actions: upload, metadata generated, approved, published, failed, member joined, etc.
- Filter by member, by video, by action type
- Used for team accountability
- Backed by an append-only `activity_events` table (workspace, actor, video, kind, payload, created_at)

---

## 7. Monetisation & Pricing

Three plans: **Free**, **Pro** and **Elite**. Limits are enforced in server code; prices are configuration. No team, agency, or enterprise plans at this stage.

### Tier Design

| | Free | Pro | Elite |
|---|---|---|---|
| Price | $0 | `PLAN_PRO_PRICE` per 30 days (default 19) | `PLAN_ELITE_PRICE` per 30 days; no default, so Elite is not purchasable until a price is set (admins can still grant it) |
| Video uploads / month | 10 | Unlimited | Unlimited |
| AI metadata generations / month | 5 | Unlimited | Unlimited |
| Veo video generations / month | 0 | 5 | Unlimited |
| AI assistant messages / month | 0 (no access) | 200 | 1,000 |
| Maximum upload size | 100 MB | 500 MB | 2 GB |
| YouTube channels | 1 | No cap in code | No cap in code |

The source of truth is `PLAN_LIMITS` and `PLAN_UPLOAD_LIMIT_BYTES` in `src/server/lib/usage.ts` (an "unlimited" limit is the sentinel 999,999) and the channel rule in `src/server/lib/accounts/channels.ts`. Customer-facing plan copy lives in `src/components/billing/plans.ts`. The currency is `PESAPAL_CURRENCY` (default USD).

**Planned gating that is not enforced today** (the product intent, to be built when needed): a storage cap per plan (the earlier design had 1 GB for Free and 25 GB for Pro), auto-publish and the Publish Now queue for paid plans only, Telegram and email notifications for paid plans only (Free Discord only), a three-channel cap on Pro, and paid-only access to Content Intelligence, YouTube Analytics, Advanced Analytics and the Content Calendar. Today every plan can use these features; only the limits in the table are enforced.

### Billing Implementation
- **Payment processor: Pesapal (API 3.0)**, supporting M-Pesa, Airtel Money and cards. The provider-agnostic core is `src/server/billing/core.ts`; the Pesapal adapter is `src/server/billing/pesapal/`; the browser-facing functions are in `src/server/modules/billing.ts` (`getStatus`, `listPayments`, `createCheckout`, `changePlan`, `cancel`, `resume`) and the UI is `/billing`
- **Reelcast owns renewals.** Every charge is a one-off hosted-checkout order that buys one 30-day period; Pesapal's own recurring feature is not used. Orders live in `payment_orders`, subscriptions in `subscriptions`, and raw provider notifications in `payment_events`
- **Subscription states:** `approval_pending` → `active` → `past_due` (3-day grace) → `expired`, plus `cancelled`. Cancel takes effect at period end and can be resumed. A renewal order is prepared and the user is reminded about 3 days before the period ends; the user pays with the Renew button
- **Plan changes:** an upgrade charges the prorated difference immediately (or is deferred to the next renewal when the amount is under 1.00 in the charge currency); a downgrade is stored as `pending_plan` and applied at the next renewal; moving to Free means cancel at period end
- **Entitlement:** `users.plan` drives every limit check. `users.plan_source` (`default | subscription | admin`) records who set it: a lapse only downgrades `subscription` plans, and plans granted by an admin are never overwritten by billing code
- **Payment verification:** the IPN endpoint (`/api/webhooks/pesapal/ipn`) and the browser return (`/api/billing/callback`) never grant access by themselves. They only say which order to look at; the server then asks Pesapal for the transaction status and checks the merchant reference, amount and currency before applying. A payment is applied exactly once (the order row is locked and `applied_at` is set in the same transaction as the plan change)
- **Safety nets:** background sweeps `billing.renewal` and `billing.expiry` (every 15 minutes) and `billing.reconcile` (every 5 minutes, polls Pesapal for unpaid orders older than 10 minutes so a lost notification cannot strand a payment)
- **Configuration:** Pesapal consumer key and secret and the sandbox/live switch are set in Admin → Settings (stored encrypted in `platform_settings`, with `PESAPAL_CONSUMER_KEY` / `PESAPAL_CONSUMER_SECRET` as a fallback); the IPN is registered from the same page with a button. Prices come from `PLAN_PRO_PRICE` / `PLAN_ELITE_PRICE`, and `NEXT_PUBLIC_APP_URL` must be a public https URL so Pesapal can reach the IPN
- **Usage metering:** plan limits are enforced by `consumeQuota` in `src/server/lib/usage.ts`, which increments the month's counter in `usage_ledger` (`videos_uploaded`, `metadata_generated`, `veo_generated`, `ai_messages_used`; month key `YYYY-MM`, UTC) and checks the limit in a single atomic SQL statement, so concurrent requests cannot exceed a limit. Work that fails before doing anything billable gives its unit back with `refundQuota`

---

## 8. Technical Architecture Evolution

### 8.1 Queue System
**Current:** a portable Postgres queue in `src/server/jobs/`. `jobs` hold user-visible work tied to a video (publish, generation; one active job per video and type), `tasks` hold internal steps with an optional `dedupe_key` (auto-publish runs, scheduled metadata, digests, analytics chunks), and `job_schedules` drives periodic sweeps. A runner tick (`runTick`) recovers stuck rows, runs due sweeps, and then drains due jobs and tasks. It is driven by Supabase pg_cron calling `/api/cron/tick` every minute in production and by an in-process timer in development. Rows are claimed with `FOR UPDATE SKIP LOCKED`, so several ticks can run concurrently without double-running work. Delivery is at-least-once, handlers must be idempotent, and long operations resume across ticks by returning `deferMs` without consuming a retry attempt. Failed jobs trigger `onJobFailed` hooks.

**At scale:** the current limits are a per-tick concurrency of 3 handlers, a once-a-minute cadence in production, and the host's function time limit (about 300 s on the current hosting plan). If publish volume outgrows that:
- Run the same `runTick` from a dedicated long-lived worker, or from more frequent ticks, since claiming is safe under concurrency
- Add per-type concurrency caps (for example max 10 active publish jobs at once) and a `priority` column so manual "Publish Now" jobs jump ahead of an auto-publish batch (claims are ordered only by `run_at` today)
- Move to a managed queue if Postgres polling becomes the bottleneck, keeping the handler contract unchanged

### 8.2 Storage Evolution
**Current:** Cloudinary holds all video files: signed direct browser uploads, Veo outputs copied in server-side, frame extraction and thumbnail transforms through URL transforms, and deletion after the YouTube upload completes. Cloudflare R2 is not used.
**Issue:** Veo-generated and uploaded videos are large (up to 2 GB on the highest plan); Cloudinary bandwidth costs scale with video count, and the publisher re-reads the full file from Cloudinary in chunks.
**Future:** move raw video storage to a zero-egress object store (for example Cloudflare R2) and keep Cloudinary only for thumbnail generation and frame-extraction transforms. The publisher already reads its source by URL in ranged chunks, so it would need only a different source resolver.

### 8.3 Multi-Tenancy Isolation
Today every server function scopes its queries by the signed-in user's id, and the database is closed to everything except the server role (row-level security is enabled on every table with no policies, and `anon` / `authenticated` have no grants). RLS is therefore a lock on direct database access, not the tenancy mechanism; isolation between tenants is the `user_id` filter in application code.

For organizations, the same discipline moves to org and workspace scope. The RPC context resolves the active org and workspace and the caller's role, and every query filters on them:

```ts
// Current (single user)
db.select().from(videos).where(and(eq(videos.id, id), eq(videos.userId, ctx.userId)));

// Multi-tenant
db.select().from(videos).where(and(
  eq(videos.orgId, ctx.orgId),
  eq(videos.workspaceId, ctx.workspaceId),
  eq(videos.id, id),
));
```

Indexes to add: `(org_id, status)`, `(workspace_id, created_at)` on `videos`, and `(workspace_id)` on `jobs` and `youtube_channels`. A shared query helper that injects the scope (and checks the role against the permission matrix in 6.2) keeps modules from forgetting it. If tenant data is ever read through Supabase client libraries rather than the server, real RLS policies keyed on org membership become necessary as defence in depth.

### 8.4 YouTube Quota Management
The YouTube Data API has a daily quota of 10,000 units per Google Cloud project. A resumable upload costs 1,600 units, so about six uploads fit in a day before multi-channel use and analytics polling tighten it.
- **Built:** units are counted per user per UTC day in `youtube_quota_usage` (uploads, health probes, content-intelligence calls), the analytics ingest consults it, and Admin → YouTube quota shows each user's usage with a warning colour at 80%
- **Remaining:** a project-wide total on the admin page (quota is shared across all users, but the table is per user), a warning or soft block before a publish when quota is low, and a distinction between the Data API and Analytics API budgets

### 8.5 Monitoring & Observability
**Current:** host function logs, the admin Jobs and Overview pages (recent and failed jobs, 24-hour publish success rate), `job_schedules.last_error` for sweep failures, `onJobFailed` hooks (the generation job uses one to mark the video failed and notify the owner; publish records its failures inside the job), and optional PostHog product analytics.
**What to add:**
- Sentry for Next.js error tracking (client + server)
- Alerting on the publish failure rate: if the share of failed publish jobs exceeds 5% in a 1-hour window, send a Discord alert to the Reelcast internal Discord
- Uptime and heartbeat monitoring for `/api/cron/tick` (if the tick stops, nothing publishes), `/api/youtube/callback` and `/api/webhooks/pesapal/ipn`
- Alerts when `billing.reconcile` finds orders it cannot settle
- YouTube API quota alert at 80% usage
- Cloudinary storage usage alert at 80% of plan limit

---

## 9. KPIs & Success Metrics

### Product Metrics
| Metric | Definition | Target (6 months) |
|--------|-----------|-------------------|
| Videos published via Reelcast | Total across all users | 10,000 |
| Auto-publish adoption | % of users with auto-publish enabled | 60% |
| AI metadata generation rate | % of videos with AI metadata before publish | 80% |
| Publish success rate | Successful publishes / total attempts | >98% |
| Time to first publish | Signup to first video published | <15 minutes |
| Weekly active users | Users who publish ≥1 video in the last 7 days | 70% of paid users |

### Business Metrics
| Metric | Definition | Target (12 months) |
|--------|-----------|-------------------|
| MRR | Monthly recurring revenue | $10,000 |
| Paid conversion | Free → Pro | 15% |
| Net Revenue Retention | MRR retained + expansion / starting MRR | >110% |
| Churn | Paid users cancelling per month | <5% |

---

## 10. Build Order Recommendation

Sequence prioritises (a) immediate single-user polish, (b) features that drive Pro conversions, (c) features that reduce churn.

**Sequence, with current status:**
1. **Thumbnail system** — Visual polish; biggest perceived quality uplift. *Partially built* (Veo posters stored; uploads derive theirs at render time; AI frame picker)
2. **Auto-generate on upload** — Removes the #1 friction point in the daily workflow. *Built*
3. **Schedule button on video detail** — Removes navigation friction for single-video scheduling. *Built*
4. **Email notifications** — Required for users without Discord/Telegram. *Built*
5. **Content Calendar** — Minimal strip on `/schedule` + full `/content-calendar` page; first "wow" moment. *Partially built* (read-only; drag-and-drop scheduling remains)
6. **Publish Queue with Publish Now** — `/queue` page; gives users granular control. *Built* (arrow reordering)
7. **OAuth health dashboard** — Prevents silent publish failures from destroying trust. *Mostly built* (global alert banner remains)
8. **YouTube Analytics integration** — Key retention driver; users stay active once they see performance data. *Partially built* (views, watch time, likes, comments, subscribers; no impressions/CTR/revenue)
9. **Admin Dashboard** — Internal operational visibility; required before scaling user base. *Built*
10. **AI Assistant (DeepSeek)** — Differentiation from all competitors; drives Pro upgrades. *Partially built* (chat with context; tool-use actions remain)
11. **Content Intelligence** — Trending topics + Idea Vault; makes Reelcast part of the creative process. *Partially built* (trending, keyword search, content gaps, idea list; scoring, prediction, idea-to-generation remain)
12. **Advanced Analytics** — Retention curves, traffic sources, best posting times. *Not started* (a basic best-times query exists)
13. **Billing (Free + Pro)** — Monetisation infrastructure; unlock after AI features are stable. *Built* (Pesapal; Free / Pro / Elite)
14. **Multi-channel support** — Expands Pro value; builds on billing foundation. *Partially built* (multiple channels and primary channel; per-video selection and duplicate guard remain)
15. **Organizations & Teams** — v2.0; opens the collaborative creator market. *Not started*

**What is left, in a sensible order:** persist upload thumbnails and finish the thumbnail flow; calendar drag-and-drop and the library multi-select toolbar; the channel selector and duplicate-publish guard; the OAuth alert banner; assistant tool use; impressions/CTR and the Advanced Analytics set; Opportunity Score and idea-to-generation; plan gating beyond usage limits; then Organizations & Teams.
