# Reelcast — Product Specification

**Version:** 1.0  
**Date:** 2026-08-08  
**Status:** Active development

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
4. [Authentication](#authentication)
5. [User Features](#user-features)
   - [Video Upload](#video-upload)
   - [Video Generation (Veo)](#video-generation-veo)
   - [AI Metadata Generation](#ai-metadata-generation)
   - [YouTube Publishing](#youtube-publishing)
   - [Smart Scheduling](#smart-scheduling)
   - [Auto-Publish](#auto-publish)
   - [Content Calendar](#content-calendar)
   - [Queue](#queue)
   - [Analytics](#analytics)
   - [AI Assistant](#ai-assistant)
   - [Idea Vault](#idea-vault)
   - [Notifications](#notifications)
   - [Content Intelligence](#content-intelligence)
6. [User Settings](#user-settings)
7. [Admin Panel](#admin-panel)
8. [Pricing Tiers](#pricing-tiers)
9. [API Key Model](#api-key-model)
10. [Security](#security)
11. [Data Model](#data-model)
12. [Deployment](#deployment)

---

## Overview

Reelcast is an AI-powered YouTube publishing platform for content creators. It covers the full lifecycle of a YouTube Short: create or upload a video, generate SEO-optimised metadata using AI, schedule or auto-publish to YouTube, and track performance analytics — all from one dashboard.

**Core value proposition:**
- Upload existing videos *or* generate new ones with Google Veo
- AI writes titles, descriptions, and tags automatically (Gemini, platform-provided key)
- Direct YouTube publishing — no manual upload
- Smart scheduling and fully automatic drip publishing
- AI assistant answers questions about the channel and content strategy (DeepSeek, platform-provided key)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js (App Router), React, Tailwind CSS, shadcn/ui |
| Backend / DB | Convex (real-time database + serverless functions) |
| Auth | Supabase (email/password, OAuth) + custom RS256 JWT for Convex |
| File storage | Cloudflare R2 (raw video files, $0.015/GB, $0 egress) |
| Video processing | Cloudinary (thumbnail extraction, frame analysis) |
| Video generation | Google Veo 2 / Veo 3 via Gemini Developer API (BYOK) |
| AI metadata | Google Gemini 2.5 Flash (platform key) |
| AI assistant | DeepSeek Chat (platform key) |
| Email notifications | Resend (BYOK — user provides their own key) |
| Package manager | Bun |
| Icons | Lucide React (no emojis anywhere in the UI) |

---

## Architecture

### Route Groups

The Next.js app uses three route groups:

- `(app)` — authenticated user area (dashboard, upload, settings, admin)
- `(auth)` — sign-in / sign-up / password reset pages
- `(marketing)` — public landing page and pricing

### Convex Backend

All persistent data and business logic lives in Convex. The backend is split into:

- **`convex/`** — public-facing queries and mutations called by the client
- **`convex/actions/`** — Node.js actions that call external APIs (YouTube, Gemini, DeepSeek, Resend)
- **`convex/admin/`** — admin-only queries, mutations, and actions
- **`convex/scheduled/`** — scheduled functions triggered by Convex crons or `scheduler.runAt`
- **`convex/lib/`** — shared utilities (auth helpers, AI client factory)

### Data Flow

```
Browser → Next.js App Router → Convex (queries/mutations) → Convex Actions → External APIs
                                      ↓
                             Convex Scheduled Functions (crons, runAt)
```

Real-time updates to the UI happen automatically through Convex's reactive query subscriptions — no manual polling.

---

## Authentication

### Provider

Authentication is handled by **Supabase**. Users sign up and log in with email/password. The Supabase session produces a JWT that is exchanged for a Convex-compatible JWT via a custom minting function (`mintConvexJwt`) using RS256 signing.

### YouTube OAuth

YouTube is connected separately via Google OAuth (scope: YouTube Data API + Analytics API). The OAuth flow:

1. User clicks "Connect YouTube" in Settings
2. App redirects to Google's OAuth consent screen
3. Google redirects back to `/api/youtube/callback`
4. The callback handler exchanges the auth code for access + refresh tokens
5. Calls the YouTube Data API to retrieve the channel ID and channel name
6. Saves tokens and channel info to the user's record in Convex via `saveYoutubeTokens`

**Channel uniqueness:** Each YouTube channel can only be linked to one Reelcast account. If a user tries to connect a channel already claimed by another account, the OAuth callback catches the `CHANNEL_ALREADY_CLAIMED` error from Convex and redirects back to settings with a human-readable error message. The `youtubeChannelId` field is indexed and checked for uniqueness before saving.

### Token Refresh

YouTube access tokens expire. The platform automatically detects expired tokens (`youtubeOAuthStatus: "token_expired"`) and uses the stored refresh token to obtain a new access token before publishing.

---

## User Features

### Video Upload

**Route:** `/upload`

Users upload video files directly to Cloudflare R2 via a presigned URL. The upload flow:

1. Client requests a presigned R2 upload URL from the API
2. File is streamed directly to R2 (never touches the Next.js server)
3. On completion, a `videos` record is created in Convex with `status: "draft"`
4. Cloudinary processes the file to extract a thumbnail
5. AI metadata generation is automatically queued (if enabled in settings)

**Accepted formats:** MP4, MOV, AVI, MKV, WebM, FLV, WMV

**Plan limits:** Free plan — 10 uploads/month; Pro/Elite — unlimited

### Video Generation (Veo)

**Route:** `/generate`

Users can generate YouTube Shorts from a text prompt using Google's Veo 2 or Veo 3 models.

**How it works:**

1. User writes a prompt (optionally with a negative prompt)
2. Selects model (Veo 2 / Veo 3), resolution, aspect ratio, and duration
3. Generation is submitted to the Gemini Developer API using the user's own API key (BYOK)
4. A `generations` record tracks the operation; a background action polls until complete
5. The generated video is downloaded and stored in R2
6. A `videos` record is created and AI metadata is automatically generated

**Veo defaults** are configurable per-user in Settings > AI: model, resolution (720p / 1080p), aspect ratio (16:9 / 9:16 / 1:1), duration (5–8 seconds), and prompt enhancement toggle.

**BYOK:** Veo generation costs are paid by the user via their own Gemini API key. The platform does not cover Veo costs.

**Plan limits:** Free plan — 0 generations/month; Pro — 5/month; Elite — unlimited

### AI Metadata Generation

**Route:** Triggered automatically after upload or generation; also available manually per video

AI generates SEO-optimised titles, descriptions, and tags for each video using **Google Gemini 2.5 Flash** (platform-provided key — users do not need their own Gemini key for this).

**For uploaded videos:** Gemini analyses 3 extracted frames from Cloudinary (at 0%, 25%, 75% of the video) using inline image tokens (~1,200 tokens per video). If frame extraction fails, falls back to the Gemini Files API (higher cost).

**For generated videos:** Gemini analyses the prompt directly without video frames.

**What it generates:**
- **Title** (max 55 chars): curiosity-gap hook using VidIQ-style patterns — "Why [unexpected claim]", "The Truth About [topic]", "Stop [action] — Here's Why"
- **Description**: punchy first line (YouTube search snippet), viewer benefit, CTA, and `#Shorts` hashtag line
- **Tags** (12–15): tiered by competition — 2 broad, 3–4 medium niche, 5–6 specific to the video, 2–3 long-tail phrase tags

**Personalisation:** The AI incorporates the user's channel guidelines (tone, niche, audience, forbidden words) if configured in brand memory settings.

**Plan limits:** Free plan — 5 metadata generations/month; Pro/Elite — unlimited

### YouTube Publishing

**Route:** `/history` (Publish button per video)

Once a video has `status: "ready"`, it can be published to the user's connected YouTube channel.

**Publishing options:**
- Privacy status: Public, Private, Unlisted
- Publish as: Short or regular video
- Scheduled publish time (optional)

The YouTube Data API (`videos.insert`) uploads the file and sets the title, description, and tags. On success, the video record is updated with the YouTube video ID and `status: "published"`.

**Quota tracking:** Each YouTube publish operation consumes YouTube API quota units. The platform tracks daily quota usage per user in the `youtubeQuotaUsage` table.

### Smart Scheduling

**Route:** `/schedule`

Users can schedule videos to be published at a specific date and time. The platform uses Convex's built-in scheduler (`scheduler.runAt`) to fire the publish action at the exact requested time.

Scheduled videos show with `status: "scheduled"` in the library. The content calendar provides a visual view of all scheduled videos by day.

### Auto-Publish

**Route:** Settings > General (auto-publish section) or Dashboard widget

Auto-publish automatically drip-publishes ready videos to YouTube on a configurable schedule.

**Configuration options:**
- Enable / disable toggle
- Interval (e.g. every 6 hours, 12 hours, 24 hours)
- Videos per batch (how many to publish each interval)
- Privacy status (public / private / unlisted)
- Time slots (specific hours in EAT — Kampala time, UTC+3)
- Timezone offset (defaults to EAT, +3)

**How it works:**

1. When enabled, a Convex action `runAutoPublishBatch` is scheduled to fire at the next time slot
2. It picks the oldest `status: "ready"` videos (up to `autoPublishCount`)
3. Uses an atomic claim mutation to prevent double-publishing under concurrent execution
4. Publishes each video to YouTube, then reschedules the next batch

The dashboard shows a countdown to the next auto-publish and the current queue depth.

### Content Calendar

**Route:** `/content-calendar`

A monthly calendar view showing all scheduled and published videos by date. Users can:
- See which days have scheduled content
- Click a day to see what's queued
- Navigate between months

### Queue

**Route:** `/queue`

Shows all videos currently in `status: "queued"` or `status: "generating"` (Veo jobs in progress). Displays generation progress and estimated time remaining.

### Analytics

**Route:** `/analytics`

Displays YouTube performance data for published videos, fetched from the YouTube Analytics API and cached in the `videoAnalytics` table.

**Metrics per video:**
- Views
- Watch time (minutes)
- Average view duration (seconds)
- Impressions and CTR
- Likes and comments
- Subscribers gained
- Estimated revenue, RPM, CPM
- Traffic source breakdown (search, suggested, external)

Data is fetched on demand and cached. The cache is refreshed when the user visits the analytics page.

### AI Assistant

**Route:** Dashboard sidebar or `/ai-config`

A persistent chat assistant powered by **DeepSeek Chat** (platform-provided key — users do not need their own DeepSeek key).

The assistant has full context of the user's channel:
- Video library summary (status counts, recent 10 videos with titles/tags/status)
- Current settings (niche, brand voice, target audience, auto-publish schedule)
- Current time in EAT

The assistant can answer questions like "How many videos are ready to publish?", "What's my next auto-publish time?", "Suggest titles for a motivational video about resilience."

**Sessions:** Conversations are saved as `aiSessions` with full message history (`aiMessages`). Users can start new sessions or continue existing ones.

**Available to:** Pro and Elite plans

### Idea Vault

**Route:** `/ideas`

A scratchpad for content ideas before they become videos.

Each idea has:
- Title
- Notes (free text)
- Tags
- Status: `concept` → `in_production` → `published`
- Optional scheduled generation date
- Optional link to a video once created

Users can promote an idea directly to a Veo generation job, which creates a video using the idea's title as the prompt.

### Notifications

**Route:** `/settings/notifications`

The platform supports three notification channels. All are optional and independently configurable.

**In-app notifications:** Always available. Displayed in the notifications panel. Types: info, success, warning, error.

**Telegram notifications (BYOK):** User provides their own Telegram chat ID. The platform sends messages via a shared Telegram bot. Configurable per event type.

**Discord notifications (BYOK):** User provides their own Discord webhook URL. The platform sends messages to the webhook. Supports a custom message template with placeholders.

**Email notifications (BYOK):** User provides their own Resend API key and a "from" email address. The platform sends transactional emails via Resend. Users bear the Resend cost.

**Notification events:**
- Publish success
- Publish failure
- Metadata ready
- Weekly digest
- Storage warning

### Content Intelligence

**Route:** `/intelligence`

Users can add competitor YouTube channel IDs to monitor. The platform tracks competitor content patterns to inform the user's content strategy. This data is stored as `competitorChannelIds` in the user's settings.

---

## User Settings

### General Settings (`/settings`)

- Auto-publish configuration (enable/disable, interval, batch size, time slots, privacy)
- YouTube channel connection / disconnection
- YouTube OAuth status display

### AI Settings (`/settings/ai`)

**Video Generation Defaults:**
- Default Veo model (Veo 2 / Veo 3)
- Resolution (720p / 1080p)
- Aspect ratio (16:9, 9:16, 1:1)
- Duration (5 / 6 / 7 / 8 seconds)
- Prompt enhancement toggle

**Metadata Generation Defaults:**
- Auto-generate after upload toggle
- Which fields to generate (title / description / tags)
- Tone (professional, casual, inspirational, educational, entertaining)
- Language (English, French, Spanish, etc.)
- Description length (short / medium / long)
- Channel guidelines (free text injected into every metadata prompt)

**Brand Memory:**
- Niche
- Target audience
- Brand voice
- Forbidden words
- CTA preferences

Brand memory is injected into AI metadata prompts and the AI assistant's system context.

### Notification Settings (`/settings/notifications`)

Per-channel and per-event toggles. Inputs for Telegram chat ID, Discord webhook URL, Resend API key, and from email address.

### Telegram Settings (`/settings/telegram`)

Separate page for Telegram-specific configuration including bot setup instructions and chat ID retrieval.

---

## Admin Panel

**Route:** `/admin`

Accessible only to users with `isAdmin: true`. Admin navigation links to all sub-pages.

### Users (`/admin/users`)

Table of all registered users with:
- Search bar (searches name and email simultaneously)
- Plan filter pills: All / Free / Pro
- YouTube filter pills: All / Connected / No YouTube
- 20 per page with previous/next pagination and page count
- Columns: name, email, plan, YouTube status, join date

### Videos (`/admin/videos`)

Table of all videos across all users with:
- Search bar (searches title and username simultaneously)
- Status filter pills: All / Draft / Ready / Scheduled / Published / Failed
- 20 per page with pagination
- Columns: title, user, status, created date

### Jobs (`/admin/jobs`)

Background job monitoring with two tabs:

**Recent tab:** Last 100 jobs (generation + publish) across all users, 20 per page with pagination
**Failed tab:** All jobs with `status: "failed"`, 20 per page with pagination

Columns: type, video title, user, status, error message, started/completed timestamps

### Quota (`/admin/quota`)

Per-user YouTube API quota usage tracker. Shows daily quota units consumed against the YouTube API daily limit (10,000 units).

### Storage (`/admin/storage`)

Overview of R2 storage usage across all users. Shows raw file sizes and processed file sizes.

### Usage (`/admin/usage`)

Monthly usage metering across all users with:
- Plan filter: All / Free / Pro
- At-limit filter: shows only users who have reached their monthly limit on any counter
- Table columns: user, plan, videos uploaded, metadata generated, Veo generated (with limits shown)

### Settings (`/admin/settings`)

Platform-level API key management. Two cards:

**DeepSeek — AI Assistant:**
- Password input to set/replace the API key
- Show/hide toggle
- Save button
- Test button: calls the DeepSeek API with a minimal prompt and shows success or error inline
- "Key is configured" indicator when a key is saved

**Gemini — Metadata Generation:**
- Same UI as DeepSeek card
- Falls back to `GEMINI_API_KEY` env var if no key set in DB
- Test button: calls Gemini 2.0 Flash with a minimal prompt and shows the model's reply

Keys are stored in the `platformSettings` singleton table. The actual key values are never sent to the browser — only a boolean `keySet` status is exposed to the client. Internal server-side queries retrieve the actual values for use by AI actions.

---

## Pricing Tiers

> Note: Pricing is designed for long-term sustainability. Platform costs are minimal because Veo generation and email are BYOK. Platform's main costs are DeepSeek (~$0.001/message) and Gemini (~$0.0003/metadata generation).

### Free

**Price:** $0/month

**Limits:**
- 10 video uploads per month
- 5 AI metadata generations per month
- Max upload file size: 100 MB
- No Veo video generation
- No AI assistant access
- No auto-publish
- No smart scheduling

**Included:**
- YouTube publishing (manual)
- Basic analytics
- Idea vault
- In-app notifications

### Pro

**Price:** $29/month

**Limits:**
- Unlimited video uploads
- Unlimited AI metadata generations
- Max upload file size: 500 MB
- 5 Veo video generations per month (BYOK — user's own Gemini key)
- AI assistant (DeepSeek, platform key)
- Auto-publish
- Smart scheduling

**Included:** Everything in Free, plus:
- Content calendar
- Discord + Telegram notifications (BYOK)
- Email notifications (BYOK)
- Brand memory
- Content intelligence (competitor monitoring)

### Elite

**Price:** $69/month

**Limits:**
- Unlimited video uploads
- Unlimited AI metadata generations
- Max upload file size: 2 GB
- Unlimited Veo video generations (BYOK)
- AI assistant (priority)
- Unlimited auto-publish slots

**Included:** Everything in Pro, plus:
- Priority metadata generation (queue priority)
- Extended analytics history
- Bulk metadata regeneration
- Advanced scheduling (time-slot targeting)

> **Implementation note:** The `plan` field in the schema currently supports `"free"` and `"pro"`. Adding `"elite"` requires a schema migration and enforcement updates in `usageLedger.ts` and gating logic across the codebase.

---

## API Key Model

The platform distinguishes between three types of API keys:

### Platform Keys (Admin-managed)

Stored in the `platformSettings` Convex table. Set by the admin via Admin > Settings. Never exposed to the client — only `{ deepseekKeySet: boolean, geminiKeySet: boolean }` is sent to the browser. Internal Convex queries retrieve the actual values for server-side use.

| Key | Service | Purpose | Cost bearer |
|-----|---------|---------|-------------|
| `deepseekApiKey` | DeepSeek Chat | AI assistant for all Pro/Elite users | Platform |
| `geminiApiKey` | Gemini 2.5 Flash | AI metadata generation for all users | Platform |

The Gemini key falls back to the `GEMINI_API_KEY` environment variable if not set in the database, providing a migration path.

### BYOK — User's Own Key

Users provide these keys in their own settings. They are stored per-user and the cost is borne by the user.

| Key | Service | Purpose |
|-----|---------|---------|
| `resendApiKey` | Resend | Email notifications |
| Gemini key (in AI settings) | Google Gemini / Veo | Video generation only |

> Note: DeepSeek key was previously a user BYOK field (`settings.deepseekApiKey`). It has been migrated to a platform key. The field remains in the schema for backward compatibility but is no longer used by `aiAssistant.ts`.

### Environment Variables

Used for infrastructure-level secrets that are not user-configurable:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `CONVEX_DEPLOY_KEY`
- `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- `GEMINI_API_KEY` (fallback if not set in `platformSettings`)
- `TELEGRAM_BOT_TOKEN`

---

## Security

### HTTP Security Headers

Added to all routes via `next.config.ts` `headers()`:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME sniffing |
| `X-Frame-Options` | `SAMEORIGIN` | Prevents clickjacking |
| `X-XSS-Protection` | `1; mode=block` | Legacy XSS filter |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()` | Disables browser features |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | Isolates browsing context; allows Google OAuth popup |
| `Cross-Origin-Resource-Policy` | `same-origin` | Restricts cross-origin resource loading |

**COOP note:** Set to `same-origin-allow-popups` (not `same-origin`) to preserve the Google OAuth popup window flow. Strict `same-origin` would break the YouTube connection.

**CSP note:** Content-Security-Policy is intentionally omitted — it requires careful per-domain tuning for Convex WebSockets, YouTube iframes, Cloudinary URLs, and Google APIs. Deferred for a later iteration.

**COEP note:** `Cross-Origin-Embedder-Policy` is omitted because it would break YouTube iframe embeds.

### Security.txt

`public/.well-known/security.txt` — contact information for responsible disclosure:

```
Contact: mailto:manb10291@gmail.com
Preferred-Languages: en
Expires: 2027-08-06T00:00:00.000Z
```

### Admin Access Control

All admin routes and Convex admin queries/mutations verify `user.isAdmin === true`. The check is enforced server-side in each handler — no client-side gating alone.

---

## Data Model

All tables live in Convex. Table definitions are in `convex/schema.ts`.

### `users`

| Field | Type | Description |
|-------|------|-------------|
| `supabaseId` | string | Supabase user ID (primary auth identifier) |
| `email` | string | User's email address |
| `name` | string? | Display name |
| `imageUrl` | string? | Profile photo URL |
| `youtubeConnected` | boolean | Whether YouTube is currently connected |
| `youtubeChannelId` | string? | YouTube channel ID — unique across all users |
| `youtubeChannelName` | string? | Human-readable channel name |
| `youtubeAccessToken` | string? | Current OAuth access token |
| `youtubeRefreshToken` | string? | OAuth refresh token (long-lived) |
| `youtubeTokenExpiry` | number? | Access token expiry timestamp (ms) |
| `youtubeOAuthStatus` | enum? | `connected` / `token_expired` / `revoked` / `unknown` |
| `isAdmin` | boolean? | Admin flag |
| `plan` | enum? | `free` / `pro` (Elite pending) |

**Indexes:** `by_supabase_id`, `by_email`, `by_youtube_channel_id`

### `videos`

| Field | Type | Description |
|-------|------|-------------|
| `userId` | id(users) | Owner |
| `title` | string | Working title |
| `status` | enum | `draft` / `queued` / `generating` / `ready` / `scheduled` / `publishing` / `published` / `failed` |
| `rawFileKey` | string | R2 key for the source file |
| `rawFileSize` | number | File size in bytes |
| `processedFileKey` | string? | R2 key for the Cloudinary-processed version |
| `thumbnailUrl` | string? | Cloudinary thumbnail URL |
| `aiTitle` | string? | AI-generated title |
| `aiDescription` | string? | AI-generated description |
| `aiTags` | string[]? | AI-generated tags |
| `aiConfig` | object? | Veo generation config (model, prompt, resolution, etc.) |
| `sourceType` | enum? | `upload` or `generate` |
| `publishedVideoId` | string? | YouTube video ID after publishing |
| `publishedAt` | number? | Publish timestamp (ms) |
| `scheduledPublishAt` | number? | Requested publish time (ms) |
| `privacyStatus` | enum? | `private` / `public` / `unlisted` |
| `publishAs` | enum? | `short` or `video` |

**Indexes:** `by_user`, `by_status`, `by_user_status`

### `jobs`

Tracks background operations (Veo generation, YouTube publish).

| Field | Type | Description |
|-------|------|-------------|
| `type` | enum | `generation` or `publish` |
| `status` | enum | `pending` / `processing` / `completed` / `failed` |
| `error` | string? | Error message if failed |
| `startedAt` / `completedAt` | number? | Timestamps |

### `settings`

One row per user. Stores all user preferences: auto-publish config, Veo defaults, AI metadata defaults, brand memory, notification channel credentials.

### `generations`

Records each Veo generation attempt with its parameters, Veo operation name, output URL, and timing.

### `notifications`

In-app notification inbox. Each row has a title, message, type (info/success/warning/error), and `isRead` flag.

### `videoAnalytics`

Cached YouTube Analytics API data per video. Refreshed on demand. Stores views, watch time, CTR, revenue, and traffic source breakdowns.

### `ideas`

Idea Vault entries. Each idea has a status lifecycle (`concept` → `in_production` → `published`) and can be linked to a video.

### `aiSessions` + `aiMessages`

AI assistant conversation history. Each session has a title and `lastMessageAt`. Messages store role (`user` / `assistant`) and content.

### `youtubeQuotaUsage`

Daily YouTube API quota tracking per user. One row per `(userId, date)`.

### `usageLedger`

Monthly plan usage counters. One row per `(userId, month)`. Fields: `videosUploaded`, `metadataGenerated`, `veoGenerated`. Limits enforced at action time by `checkLimit`.

**Current limits:**

| Field | Free | Pro |
|-------|------|-----|
| `videosUploaded` | 10 | unlimited |
| `metadataGenerated` | 5 | unlimited |
| `veoGenerated` | 0 | 5 |

### `platformSettings`

Singleton table — always one row. Stores `deepseekApiKey` and `geminiApiKey`. Key values are never sent to the client; only boolean status flags are exposed publicly.

---

## Deployment

### Stack

- **Frontend + API routes:** Vercel (Next.js)
- **Backend + DB:** Convex Cloud (managed)
- **Auth:** Supabase (managed)
- **File storage:** Cloudflare R2
- **Video processing:** Cloudinary (managed)

### Environment

All secrets are set as Vercel environment variables and Convex environment variables. No secrets are committed to the repository.

### Build

```bash
bun install
bunx convex codegen   # regenerate TypeScript bindings after schema changes
bun run build         # Next.js production build
```

Always use `bun` — never `npm` or `yarn`.

### Convex Schema Changes

After any change to `convex/schema.ts`:
1. Run `bunx convex codegen` to regenerate `convex/_generated/`
2. Commit the regenerated files alongside the schema change
3. Deploy to Convex with `bunx convex deploy` (or via CI)

### Crons

Defined in `convex/crons.ts`. Currently used for:
- Auto-publish batch scheduling
- YouTube token refresh checks
- Weekly digest notifications
