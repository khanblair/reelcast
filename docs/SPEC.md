# Reelcast — Product Specification

**Version:** 2.0  
**Date:** 2026-10-09  
**Status:** Active development

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Architecture](#architecture)
   - [Route Groups](#route-groups)
   - [Server Structure (RPC Layer)](#server-structure-rpc-layer)
   - [Background Jobs](#background-jobs)
   - [Data Flow](#data-flow)
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
   - [Billing](#billing)
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
- AI assistant answers questions about the channel and content strategy (DeepSeek)
- Subscriptions paid through Pesapal (M-Pesa, Airtel Money, cards)

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS 4, shadcn/ui (Radix) |
| Client data layer | TanStack Query behind a typed RPC client (`src/lib/rpc/client.ts`) |
| Backend | Next.js route handlers plus typed, zod-validated RPC functions in `src/server/` (no separate backend service) |
| Database | Supabase Postgres via Drizzle ORM (0.45) and postgres.js; SQL migrations in `drizzle/` |
| Background work | Portable Postgres job queue (`src/server/jobs/`), driven by Supabase pg_cron + pg_net in production |
| Auth | Supabase Auth (email/password, Google OAuth); cookie sessions via `@supabase/ssr` |
| File storage | Cloudinary (signed direct browser uploads; Veo outputs are copied there; files are deleted after publishing) |
| Video generation | Google Veo (2, 3, 3.1 variants) through Vertex AI (service account) or the Gemini Developer API (platform key) |
| AI metadata | Google Gemini 2.5 Flash (platform key) |
| AI assistant | DeepSeek Chat (platform key, or the user's own key if one is stored) |
| Billing | Pesapal API 3.0 (one-off hosted-checkout orders) |
| Email notifications | Resend (BYOK — user provides their own key) |
| Chat notifications | Telegram bot (platform bot token, user chat ID) and Discord webhooks |
| Product analytics (optional) | PostHog (disabled unless `NEXT_PUBLIC_POSTHOG_KEY` is set) |
| Package manager | Bun |
| Icons | Lucide React (no emojis anywhere in the UI) |

---

## Architecture

### Route Groups

The Next.js app uses three route groups:

- `(app)` — authenticated user area: dashboard, upload, generate, library (`/drafts`), queue, schedule, content calendar, intelligence, ideas, history, analytics, billing, profile, settings and video detail (`/video/[id]`)
- `(admin)` — the admin console under `/admin/*`, with its own layout, sidebar and top bar (not wrapped by the user app shell)
- `(auth)` — `/sign-in` and `/sign-up` (email/password and Google). The OAuth return lands on `/auth/callback`.
- `(marketing)` — public landing page (with a pricing teaser), contact, privacy and terms

Route handlers under `src/app/api/`:

| Route | Purpose |
|-------|---------|
| `/api/rpc` | Single entry point for all browser-to-server calls |
| `/api/cloudinary/sign` | Signs direct browser uploads to Cloudinary |
| `/api/youtube/connect`, `/api/youtube/callback` | YouTube OAuth |
| `/api/billing/callback` | Customer return from the Pesapal payment page |
| `/api/webhooks/pesapal/ipn` | Pesapal payment notifications (IPN) |
| `/api/cron/tick` | Job runner entry point (called by pg_cron; guarded by `CRON_SECRET`) |

Middleware lives in `src/middleware.ts`. It refreshes the Supabase session, redirects signed-out visitors from protected routes to `/sign-in?redirect_url=...`, and marks protected pages `no-store`. It skips `/api/rpc`, `/api/cron` and `/api/webhooks`, which authenticate themselves.

### Server Structure (RPC Layer)

All persistent data lives in Postgres and all business logic runs on the server. The browser never talks to the database. Browser calls go through a typed RPC layer:

```
Browser hook (useQuery / useMutation / useAction)
  → POST /api/rpc { path, args }
  → dispatch(): resolve function → authenticate → zod-validate → run handler
  → function defined with query() / mutation() / action() in src/server/modules/**
```

- **`src/server/modules/`** — RPC functions grouped by domain (`videos`, `settings`, `queue`, `ideas`, `billing`, ...). `modules/actions/` holds functions that call external APIs (YouTube, Gemini, DeepSeek, Cloudinary); `modules/admin/` holds admin-only functions.
- **`src/server/rpc/`** — `define.ts` (the `query` / `mutation` / `action` builders), `dispatch.ts`, `registry.ts` (the list of modules the browser may call; anything not listed there is internal), `wire.ts`, `errors.ts`.
- **`src/server/lib/`** — domain logic shared by RPC functions and background jobs (publishing, generation, analytics, AI clients, notifications, YouTube helpers, plan usage metering).
- **`src/server/jobs/`** — the queue, the tick runner and the job/task/sweep handlers.
- **`src/server/billing/`** — billing core and the Pesapal adapter.
- **`src/server/auth.ts`, `src/server/crypto.ts`** — session resolution and field encryption.
- **`src/db/`** — `schema.ts` (Drizzle schema) and `client.ts`.

**Function kinds:** a `query` is read-only (the browser may poll it freely); a `mutation` writes; an `action` does side effects or external I/O and must stay short (about 30 seconds) — anything longer becomes a background job.

**Auth levels** (per function): `user` (default; signed-in user), `admin` (signed-in user whose `users.is_admin` is true, read from the database on every call), `public` (no session required; used for a few read-only queries that return empty data when signed out, and for the contact form submit).

**Wire format:** rows are converted on the way out — `id` becomes `_id`, `createdAt` also becomes `_creationTime`, dates become epoch milliseconds, and `null` fields are omitted. Errors are returned as `{ ok: false, error: { code, message } }` with codes `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`, `PLAN_LIMIT_EXCEEDED`, `RATE_LIMITED`, `CONFLICT`, `INTERNAL`.

**Browser hooks:** `useQuery`, `useMutation`, `useAction` and the `api` object in `src/lib/rpc/client.ts` sit on top of TanStack Query.

### Background Jobs

Long-running and scheduled work runs on a Postgres-backed queue (`src/server/jobs/`):

- **`jobs`** — user-visible work tied to a video (`publish`, `generation`). Shown in History. At most one active job per `(video, type)`.
- **`tasks`** — internal steps with no UI (`autoPublish.run`, `metadata.generate`, `digest.batch`, `analytics.ingestChunk`). A `dedupe_key` makes a pending task unique and lets it be cancelled by key.
- **`job_schedules`** — bookkeeping for periodic sweeps (see [Crons](#crons)).

The runner `runTick()` recovers stuck work (rows locked for more than 10 minutes), runs due sweeps, then drains due jobs and tasks until its time budget (default 240 seconds) is spent. Rows are claimed with `FOR UPDATE SKIP LOCKED`, so overlapping ticks never run the same row twice.

Delivery is at-least-once, so handlers are idempotent. Failures retry with exponential backoff (30 seconds, doubling, capped at 15 minutes; 3 attempts by default). Work that does not fit in one function run (Veo polling, large YouTube uploads) returns a `deferMs` and resumes on the next run without using a retry attempt. Failed jobs trigger `onJobFailed` hooks that leave the video in a consistent state.

Ticks are started by:

- **Production:** Supabase pg_cron + pg_net call `GET /api/cron/tick` every minute with `Authorization: Bearer <CRON_SECRET>` (installed once with `scripts/db-cron.ts`).
- **Development (opt-in):** with `DEV_TICK=1` in `.env.local`, `src/instrumentation.ts` runs the tick in-process every 5 seconds. It is off by default because dev and production can share one database; the line `[dev tick] off: ...` is printed instead.
- **After user-initiated work** (Generate, Publish now): a best-effort immediate tick (`kickRunner`), so the user does not wait for the next minute. In production always; elsewhere only with `DEV_TICK=1`.

### Data Flow

```
Browser (React + TanStack Query)
   │  POST /api/rpc  (same-origin JSON)
   ▼
Next.js route handler → dispatch → module function ──► External APIs
   │                                                    (YouTube, Gemini/Veo, DeepSeek,
   ▼                                                     Cloudinary, Pesapal, Resend, Telegram, Discord)
Postgres (Supabase, via Drizzle)
   ▲
   │ claims due jobs, tasks and sweeps
Job runner (runTick) ◄── pg_cron + pg_net → GET /api/cron/tick (every minute)
```

Some traffic bypasses RPC by design: the browser uploads video files straight to Cloudinary (using a signature from `/api/cloudinary/sign`), the YouTube OAuth flow and the Pesapal return/IPN calls hit their own route handlers.

There is no real-time push. After any mutation or action succeeds, the client invalidates the cached queries it can change (every query unless the write is listed in `src/lib/rpc/invalidation.ts`). Queries whose data changes on the server also poll while the tab is visible, at a rate that follows their own data (`src/lib/rpc/polling.ts`): the original rate (job and queue status every 4–5 seconds, the video list every 10 seconds) only while something is in flight or a schedule is about to fire, once a minute otherwise, and not at all for data only the user changes (settings while auto-publish is off). Notifications poll once a minute, billing status stays at 10 seconds and the admin billing queries at 30 seconds. `staleTime` is set per path in the same file: 60 seconds for the user, settings, channels, ideas and assistant sessions, 5–10 minutes for analytics, 10 seconds for everything else (billing and usage included). A write always refreshes what it changes, whatever the `staleTime`.

---

## Authentication

### Provider

Authentication is handled by **Supabase Auth**: email/password and Google OAuth. Sessions are cookie based (`@supabase/ssr`). On every request the server verifies the session JWT (`src/server/auth.ts`) and resolves the app user row; the first time a valid session is seen, `ensureUser` creates the `users` row (`users.id` is the Supabase auth user id). There is no separate token exchange, no custom JWT and no webhook for user sync. Deleting an auth user cascades to all of their data.

Admin status is always read from `users.is_admin` in the database, never from the token. The admin layout (`src/app/(admin)/admin/layout.tsx`) additionally checks it on the server before any admin UI is sent.

### YouTube OAuth

YouTube is connected separately from sign-in, via Google OAuth. Requested scopes: `openid`, `email`, `profile`, `youtube.upload` and `youtube.readonly` (offline access, consent prompt). The OAuth flow:

1. A signed-in user clicks "Connect YouTube" in Settings; `/api/youtube/connect` sets a random one-time `state` in an httpOnly cookie (10 minutes) and redirects to Google's consent screen
2. Google redirects back to `/api/youtube/callback`
3. The callback checks the `state` cookie and that the session is still valid, then exchanges the auth code for access and refresh tokens
4. It calls the YouTube Data API (`channels.list?mine=true`) to get the channel ID and name; a connection without a channel is rejected
5. `saveYoutubeConnection` stores the channel in `youtube_channels` with both tokens AES-256-GCM encrypted

**Channel uniqueness:** each YouTube channel can be linked to only one Reelcast account (unique index on `channel_id`). If a user tries to connect a channel already claimed by another account, the callback redirects to settings with `reason=channel_already_claimed`. Re-connecting a channel the user already owns is always allowed.

**Multiple channels:** the Free plan is limited to one channel; paid plans can connect more. The first channel becomes the primary channel (at most one primary per user). A video publishes to its own selected channel if it has one, otherwise to the primary channel. Analytics and Content Intelligence use the primary channel.

**Disconnecting:** removing a channel (or disconnecting YouTube entirely) deletes the user's YouTube-derived analytics.

### Token Refresh

YouTube access tokens expire. `getValidAccessToken` (`src/server/lib/youtube/tokens.ts`) is the only place that decrypts and refreshes them:

- an access token is reused while it has more than 5 minutes left;
- otherwise it is refreshed with the stored refresh token and the new access token is saved encrypted, with `oauth_status: "connected"`;
- Google answering `invalid_grant` means the user revoked access: the channel is marked `revoked`, the user's analytics are purged, and background work stops retrying;
- any other refresh failure marks the channel `token_expired` and is retried.

The `oauth.health` sweep also probes every connected channel every 6 hours, so revoked access is noticed before a publish fails. Users can recheck their own channel from Settings > YouTube, and admins can recheck all channels from Admin > Health.

---

## User Features

### Video Upload

**Route:** `/upload`

Users upload video files directly to Cloudinary with a signed upload. The upload flow:

1. The browser calls `POST /api/cloudinary/sign` (signed-in users only). The server fixes and signs everything about the upload (`src/server/lib/videoUpload.ts`): the caller's own folder `reelcast/videos/<userId>`, a random public id, video-only `allowed_formats`, `overwrite=false` and `max_file_size` from the user's plan. It returns the signed `params`, the signature and the upload URL (which fixes the resource type to `video`)
2. The file is sent straight from the browser to Cloudinary (with progress reporting) with exactly those params (`src/lib/upload-video.ts`); it never touches the Next.js server. Files uploaded before the per-user folder existed live at the root of the cloud and are handled identically everywhere, because every consumer works from the stored URL
3. The browser then calls `videos.create`, which checks that the URL is a genuine Cloudinary delivery URL of the app's own cloud and, in one transaction, consumes one `videosUploaded` unit and creates the `videos` row with `status: "draft"` and `source_type: "upload"` (`raw_file_key` holds the Cloudinary URL)
4. If auto-generate metadata is enabled in settings (the default), AI metadata generation is requested immediately

The drop zone accepts any file the browser reports as a video (`video/*`). No thumbnail is extracted at upload time; cards derive a preview frame from the Cloudinary URL.

**Plan limits:** Free — 10 uploads/month, 100 MB per file; Pro — unlimited uploads, 500 MB per file; Elite — unlimited uploads, 2 GB per file

### Video Generation (Veo)

**Route:** `/generate`

Users can generate YouTube Shorts from a text prompt using Google's Veo models.

**How it works:**

1. User writes a prompt (optionally with a negative prompt)
2. Selects model, resolution, aspect ratio, duration, prompt enhancement and (for models that support it) audio
3. `videos.createGenerated` creates a placeholder `videos` row (`source_type: "generate"`, settings in `ai_config`; it fails fast if the plan has no Veo allowance left), the video is set to `queued`, and a `generation` job is enqueued. The browser moves on to `/video/[id]`
4. The `generation` job is a resumable state machine; each run does one bounded step:
   - **Submit:** consume one `veoGenerated` unit (refunded if submission fails), submit the Veo operation, record a `generations` row (`submitted`) and set the video to `generating`; poll again in 15 seconds
   - **Poll:** check the operation every 15 seconds (up to 40 polls or 10 minutes; the generation moves to `processing`)
   - **Finish:** stream the output from Google (outputs are deleted by Google after about 2 days) into Cloudinary, set the video's file, size and poster, mark the video `ready` and the generation `completed`
5. AI metadata is then generated from the prompt (only if auto-generate is on and metadata quota remains), an in-app "Video generated" notification is created, and the user's outbound channels are notified through the "Metadata ready" toggle
6. A permanent error, or the last failed attempt, marks the video and generation `failed` and notifies the user. Retrying from History starts a fresh run (a new Veo operation)

**Models** (`VEO_MODEL_IDS`): Veo 3.1 Preview (default), Veo 3, Veo 3.1 Fast Preview, Veo 3 Fast, Veo 3.1 Lite Preview, Veo 2. Resolutions 720p / 1080p; aspect ratios 16:9 / 9:16 / 1:1; durations 4, 6 or 8 seconds. Audio is supported by Veo 3 / 3.1 (not Lite) and is only generated when the request runs through Vertex AI.

**Defaults** are configurable per user in Settings > AI: model, resolution, aspect ratio, duration and prompt enhancement toggle.

**Keys and cost:** Veo is **not** BYOK. Requests use the Vertex AI service account when `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_CLOUD_PROJECT` are set, otherwise the platform Gemini API key (Admin > Settings, or `GEMINI_API_KEY`). The platform bears the cost; usage is capped by plan.

**Plan limits:** Free — 0 generations/month; Pro — 5/month; Elite — unlimited

### AI Metadata Generation

**Route:** Triggered automatically after upload or generation; also available manually per video (`/video/[id]`, and in bulk on `/generate`) and on a timer from `/schedule`

AI generates SEO-optimised titles, descriptions, and tags for each video using **Google Gemini 2.5 Flash** (platform-provided key — users do not need their own Gemini key for this).

**For uploaded videos:** Gemini analyses 3 frames extracted from Cloudinary (at 0%, 25%, 75% of the video) as inline images (~1,200 tokens per video). If frames cannot be fetched, the work is handed to a background `metadata.generate` task that uses the Gemini Files API (slower and costlier), and the call returns immediately with `queued: true`.

**For generated videos:** Gemini analyses the generation prompt directly without video frames.

**What it generates:**
- **Title** (max 55 chars requested, hard-capped at YouTube's 100): curiosity-gap hook using VidIQ-style patterns — "Why [unexpected claim]", "The Truth About [topic]", "Stop [action] — Here's Why"
- **Description**: punchy first line (YouTube search snippet), viewer benefit, CTA, and `#Shorts` hashtag line
- **Tags** (12–15): tiered by competition — 2 broad, 3–4 medium niche, 5–6 specific to the video, 2–3 long-tail phrase tags

**Personalisation:** the metadata prompt currently uses the user's **tone**, **channel guidelines** (free text) and the **humanize writing** toggle. Language, description length, per-field (title / description / tags) toggles and the brand-memory fields are stored in settings but are not yet applied to the metadata prompt. (The AI assistant does use niche, target audience, brand voice and tone.)

**Manual editing:** on `/video/[id]` the Video Details card lets the user edit the title, description and tags by hand and press **Save changes** (`videos.updateMetadata`). Edits are stored in the same fields the AI writes (publishing sends `ai_title ?? title`, and the matching description and tags), so what the user sees is what is published. Limits follow YouTube and are enforced on the server: title 1–100 characters, description up to 5,000 bytes, no `<` or `>` in title or description, at most 50 tags of up to 100 characters each and 500 characters across all tags (commas and the quotes YouTube adds around tags with spaces count). Tags are trimmed and de-duplicated. Only the fields that are sent change, an edit that changes nothing adds no history entry, and a video that is `publishing` or `published` is locked.

**History and scheduling:** each regeneration keeps the previous values in `video_metadata_versions` (last 10 per video). Metadata can be scheduled for drafts from `/schedule`; the scheduled run saves the result and moves the video from `draft` to `ready`. Every attempt consumes one `metadataGenerated` unit and gives it back if generation fails.

**Thumbnails and captions:** from the video page, Gemini can pick the best of five Cloudinary frames as a suggested thumbnail image, and can draft WebVTT captions from sampled frames. Both are stored on the video for viewing and download; neither is uploaded to YouTube automatically.

**Plan limits:** Free — 5 metadata generations/month; Pro/Elite — unlimited

### YouTube Publishing

**Where:** the video detail page (`/video/[id]`: privacy, Short or regular video, schedule, Publish now), the Queue (`/queue`), Auto-Publish and Smart Scheduling. History (`/history`) shows the job log with Retry. The Library (`/drafts`) lists the user's videos and offers bulk actions (mark drafts ready, switch long videos to regular-video mode, backfill missing durations).

A video is publishable once it has `status: "ready"` (a draft becomes ready when the user marks it so, individually or in bulk, or when an AI analysis or scheduled metadata run finishes). Publishing moves `ready` / `scheduled` → `publishing` → `published` (or `failed`).

**Publishing options:**
- Privacy status: Public, Private, Unlisted
- Publish as: Short or regular video (a regular video has `#Shorts` stripped from its description)
- Scheduled publish time (optional)

**How a publish runs:** the status change and the `publish` job are created in one transaction (compare-and-swap), so a double click, the schedule sweep and auto-publish can never queue two publishes for the same video. The job:

1. Reads the AI title, description and tags (falling back to the manual ones) and the privacy / Short settings
2. Starts a **resumable upload** to the YouTube Data API (`videos.insert`) and streams the file from Cloudinary in 16 MiB chunks. Each run uploads what fits in about 200 seconds, saves the (encrypted) upload session in `jobs.metadata`, and defers; the next run asks Google what it already holds and continues. This survives the ~300 second function limit and supports files up to 2 GB
3. Stores `published_video_id` the instant Google returns it, then sets `status: "published"`, deletes the Cloudinary files (best effort) and notifies the user (in-app plus the publish-success channels)
4. A permanent problem (file gone, no connected channel, revoked access) or exhausted retries sets `status: "failed"` and sends a failure notification. YouTube quota exhaustion is retried and ends with a clear message if it persists
5. Videos stuck in `publishing` with no live job for 15+ minutes are repaired by the `publish.reconcile` sweep

**Quota tracking:** each upload consumes 1,600 YouTube Data API quota units. The platform tracks daily usage per user (UTC day) in `youtube_quota_usage`; Content Intelligence and analytics requests are counted too.

### Smart Scheduling

**Route:** `/schedule`

Users can schedule a ready video to be published at a specific date and time (with a privacy choice). The video gets `status: "scheduled"` and `scheduled_publish_at`; the content calendar shows it. There is no per-video timer: the `publish.dueSchedules` sweep runs every minute, claims every due scheduled video (`FOR UPDATE SKIP LOCKED`), moves it to `publishing` and enqueues its publish job — so a publish starts within about a minute of the requested time. A scheduled video can be unscheduled (back to `ready`) until the sweep has claimed it.

**Suggested times:** once the user has at least 5 published videos with analytics, the page suggests the top 3 publish hours based on the user's own history (shown in EAT). Because CTR is not collected (see [Analytics](#analytics)), the ranking is effectively by average views. Otherwise it reports that more data is needed.

The same page also schedules **AI metadata generation** for draft videos (a start time and a gap between videos).

### Auto-Publish

**Route:** `/schedule` (Auto mode). The dashboard shows a countdown to the next run and the current queue depth.

Auto-publish automatically drip-publishes ready videos to YouTube.

**Configuration options:**
- Start / stop
- Time slots: hours of the day in the chosen audience timezone (presets 7 AM, 12 PM, 5 PM, 8 PM, or any of the 24 hours)
- Audience timezone (offset from UTC; default EAT, UTC+3; fractional zones such as IST are supported)
- Videos per slot (how many to publish at each slot)
- Privacy status (public / private / unlisted)

The backend also supports a fixed interval (default 6 hours) when no time slots are given; the current page always uses time slots.

**How it works:**

1. Starting auto-publish saves the schedule in `settings` and enqueues an `autoPublish.run` task (dedupe key `autoPublish:<userId>`) for the first slot
2. When the task runs, it takes the user's `ready` videos in queue order (`publish_order`, then oldest first) and re-checks each file against Cloudinary. Videos whose file is missing are skipped and flagged, and the user gets one storage-warning notification through their outbound channels (subject to the master switch and the storage-warning toggle; no in-app notification is created)
3. It claims up to the configured number of healthy videos with the same atomic claim used by Publish now (so concurrent runs and manual clicks cannot double-publish) and stamps the chosen privacy
4. It then computes the next slot and reschedules the same task. An error in one batch is recorded but never ends the chain; stopping or restarting auto-publish while a batch runs is honoured

### Content Calendar

**Route:** `/content-calendar`

A calendar with year, month, week and day views showing published videos, scheduled videos, and projected auto-publish slots (ready videos assigned to upcoming slots in queue order). Users can:
- See which days have content
- Click an entry to see details and a link to the video on YouTube
- Navigate between periods

### Queue

**Route:** `/queue`

The publish queue: all of the user's `ready` and `scheduled` videos in publish order. Users can:
- Drag to reorder (`publish_order`) — auto-publish takes videos from the top
- Publish a video immediately
- Run a storage health check (verifies the files still exist in Cloudinary and flags missing ones)

It also shows ready and scheduled counts and the next auto-publish time. Videos still being generated are visible on their detail page and in History.

### Analytics

**Route:** `/analytics`

Displays YouTube performance data for published videos, fetched from the YouTube Analytics API for the user's primary channel and stored in two tables:

- **`video_analytics`** — lifetime snapshots, one row per video per UTC day, written when the user clicks "Refresh from YouTube" (the 50 most recently published videos per refresh, time-boxed at about 40 seconds) or when a single video's analytics are refreshed on its page
- **`video_daily_stats`** — per-day metrics, ingested automatically every 6 hours by the `analytics.dailyIngest` sweep: a rolling 7-day window (the API lags 48–72 hours and revises recent days), up to 200 videos per user, skipped for users whose daily YouTube quota use is already high (8,000 units)

**Metrics collected:**
- Views
- Watch time (minutes)
- Average view duration (seconds)
- Likes and comments
- Subscribers gained (and lost, in daily stats)

**Not collected:** impressions, CTR, estimated revenue, RPM, CPM and traffic-source breakdown. The columns exist in the schema but no code writes them; the UI hides CTR when there is no data.

The page also shows library totals (videos, storage, duration, active jobs), uploads over the last 7 days, status distribution, a views-over-time chart (real per-day views when daily stats exist, otherwise cumulative totals from snapshots) and the top videos by views.

Analytics derived from a YouTube authorization are deleted when the channel is disconnected or access is revoked.

### AI Assistant

**Route:** the assistant panel opened from the top bar (available on every app page). `/ai-config` is a separate page for metadata generation defaults.

A persistent chat assistant powered by **DeepSeek Chat** (`deepseek-chat`).

The assistant has context of the user's channel:
- Video library summary (status counts, recent 10 videos with titles/tags/status)
- Recent analytics summary (views, and CTR when available)
- Current settings (tone, niche, target audience, brand voice, auto-publish state)
- Current time in EAT

The assistant can answer questions like "How many videos are ready to publish?", "What's my next auto-publish time?", "Suggest titles for a motivational video about resilience."

**Sessions:** conversations are saved as `ai_sessions` with full message history (`ai_messages`); the server stores both the user message and the reply. Users can start new sessions or continue existing ones.

**Metering:** each message consumes one `aiMessagesUsed` unit (Pro 200/month, Elite 1,000/month, Free 0). A unit is returned if the assistant fails to answer, and the assistant is instructed to add a remaining-messages note once 80% of the allowance is used.

**Key:** the server uses a DeepSeek key stored in the user's own settings if present, otherwise the platform key. The current UI has no field for a personal key.

**Available to:** Pro and Elite plans

### Idea Vault

**Route:** `/ideas`

A scratchpad for content ideas before they become videos.

Each idea has:
- Title
- Notes (free text)
- Tags
- Status: `concept` → `in_production` → `published`
- Optional scheduled generation date (stored; nothing acts on it yet)
- Optional link to a video (supported by the backend; the "Link to Video" button in the UI is not implemented yet)

Ideas are not yet wired to Veo generation: there is no "generate from idea" action.

### Notifications

**Route:** `/settings/notifications`

The platform supports four notification channels. Outbound channels are optional and independently configurable.

**In-app notifications:** always created, shown in the bell in the top bar (50 most recent), with mark-read, mark-all-read and clear-all. Types: info, success, warning, error. Admins can also broadcast to all users or message one user.

**Telegram notifications:** the user provides their Telegram chat ID; the platform sends messages from its shared bot (`TELEGRAM_BOT_TOKEN`). A "test message" button is available.

**Discord notifications:** the user provides their own Discord webhook URL (only Discord webhook URLs on `discord.com` / `discordapp.com` are accepted and fetched). Supports a custom message template with `{{title}}` and `{{url}}` placeholders, applied to publish-success messages; Telegram has the same template option.

**Email notifications (BYOK):** the user provides their own Resend API key (stored encrypted) and a "from" address. The platform sends transactional emails to the account's email address via Resend. Users bear the Resend cost.

**Gating:** an outbound message is sent only if the master "Enable notifications" switch is on, the per-event toggle is on (an unset toggle counts as off), and the channel is configured. Channels are isolated — one failing never blocks the others.

**Notification events:**
- Publish success
- Publish failure
- Metadata ready (also used for "Video generated" and metadata failures)
- Weekly digest (sent once per week in the Sunday 08:00–08:59 UTC window: videos published, total views, top video)
- Storage warning (outbound channels only, no in-app entry; sent when auto-publish finds a video whose storage file is missing)

### Content Intelligence

**Route:** `/intelligence`

Research tools backed by the YouTube Data API, using the user's connected channel:

- **Trending topics:** most-popular videos (optionally by category and region) with their tags
- **Keyword search:** the most-viewed videos from the last 7 days for a keyword
- **Content gaps:** trending tags the user has not covered in their published videos' tags; it can also list recent upload titles from up to 5 competitor channels

Every request is counted against the user's YouTube quota (a search costs 100 units). Settings can store up to 50 competitor channel IDs (`competitorChannelIds`), but the current page does not let users edit them or pass them to the gap analysis, so competitor topics are empty in the UI today.

---

## User Settings

### Settings hub (`/settings`)

- Link to Billing & Plans
- AI Settings (opens the AI settings dialog)
- YouTube connection: connect / disconnect, status and the connected channel
- Telegram connection and Discord webhook cards (connect, enable, test message)

### YouTube Channels (`/settings/youtube`)

List connected channels, set the primary channel, remove a channel, check the primary channel's OAuth health, and an OAuth status guide. Free accounts see an upgrade prompt once they have one channel.

### General Settings (`/settings/general`)

Account name, email and avatar (managed by the user's Google account, read-only). App preferences are a placeholder ("coming soon").

### AI Settings (`/settings/ai`)

**Video Generation Defaults:**
- Default Veo model
- Resolution (720p / 1080p)
- Aspect ratio (16:9, 9:16, 1:1)
- Duration (4 / 6 / 8 seconds)
- Prompt enhancement toggle

**Metadata Generation Defaults:**
- Auto-generate after upload toggle
- Which fields to generate (title / description / tags)
- Tone (professional, casual, educational, entertainment, technical)
- Language (English, Spanish, French, German, Portuguese, Japanese, Chinese)
- Description length (short / medium / long)
- Channel guidelines (free text)
- Humanize writing toggle (default)

**Brand Memory:**
- Niche
- Target audience
- Brand voice
- Forbidden words
- CTA preferences

See [AI Metadata Generation](#ai-metadata-generation) for which of these settings the metadata prompt currently applies. The AI assistant's context uses niche, target audience, brand voice and tone; forbidden words and CTA preferences are stored but not yet used. `/ai-config` shows the metadata subset of these settings on its own page.

### Notification Settings (`/settings/notifications`)

Master switch, per-event toggles, and the email channel (Resend API key and from address). Telegram and Discord are connected from the settings hub.

### Telegram Settings (`/settings/telegram`)

Separate page for Telegram-specific configuration including bot setup instructions, chat ID retrieval, connection status and the message template.

### Other pages

`/profile` shows the account, plan badge and library statistics. `/billing` is described under [Billing](#billing).

---

## Admin Panel

**Route:** `/admin`

Accessible only to users with `is_admin = true`. Every admin RPC function is declared `auth: "admin"` and re-checks the flag in the database on each call, and the admin layout also gates on the server before any admin UI is sent.

**Console layout:** the admin is its own area (route group `(admin)`) with a 240px sidebar of grouped sections, a top bar with a breadcrumb, theme toggle and account menu, and a skip-to-content link. Below 1024px the sidebar collapses to an icon rail; below 768px it opens as an off-canvas menu. The sections are **Overview** · **People** (Users, Messages) · **Content** (Videos, Jobs) · **Money** (Billing, Subscriptions, Payments, Needs review, Usage) · **System** (Quota, Storage, Health, Settings). The Needs review item shows a live count. Pages that moved: `/admin/quota`, `/admin/storage` and `/admin/health` now live under `/admin/system/` and the old URLs redirect.

### Overview (`/admin`)

A **Needs attention** strip (failed jobs in the last 24 hours, payments that need review, past-due subscriptions; a calm line when there is nothing), one hero metric (24-hour publish success rate) with supporting platform numbers (total users and how many connected YouTube, total and published videos, jobs today, auto-publish active, total storage), the most recent failed jobs, and a **broadcast notification** form that sends an in-app notification to every user.

### Users (`/admin/users`)

Table of all registered users with:
- Search bar (name and email, searched in SQL)
- Plan filter pills: All / Free / Pro / Elite
- YouTube filter pills: All / Connected / No YT
- 20 per page with previous/next pagination
- Columns: name and email (with an Admin badge), plan, YouTube status, auto-publish, whether a Resend key is set, and a link to the user's detail page

### User detail (`/admin/users/[userId]`)

Account info, a **billing** card (the user's subscription and last payments), **plan** (grant Free / Pro / Elite by hand — a granted plan is recorded with `plan_source = "admin"` and is never removed by a subscription lapse), **admin access** toggle (self-demotion and removing the last remaining admin are refused), the user's videos (latest 200 plus the total count) and their 20 most recent jobs. Secrets are never shown; only "has key" flags.

### Videos (`/admin/videos`)

Table of the 200 most recent videos across all users with:
- Search bar (title, user name and email)
- Status filter pills: All / Draft / Ready / Scheduled / Published / Failed
- 20 per page with pagination
- Columns: title, user, status, size, published / scheduled time, and a delete action (hard delete with a confirmation; the Cloudinary files are removed best effort)

### Billing (`/admin/billing`)

Money is read-only here: the console shows what Pesapal reported and helps an admin decide, but refunds are done in the Pesapal dashboard (the confirmation code is shown with a copy button for that). All data comes from `admin.billing.*` (`src/server/modules/admin/billing.ts`).

- **Overview (`/admin/billing`):** active subscriptions as the hero number, then past due, awaiting payment, revenue for the last 30 days per currency (only payments that were completed *and* applied to a plan), and payments needing review. Below: the top of the review queue and the latest payments, plus a note about orders sent to Pesapal in the last 7 days that have not completed.
- **Subscriptions (`/admin/billing/subscriptions`):** every subscription with its customer, plan, status, current period end, grace period, scheduled cancellation or plan change, and how the plan was granted (subscription vs admin). Filter by status (also via `?status=`), search by email, 25 per page.
- **Payments (`/admin/billing/payments`):** every payment attempt, newest first. Filter all / completed / pending / failed / reversed, search by email. Opening a row shows its references (merchant reference, Pesapal tracking id, confirmation code), amounts, how it was applied, and the trail of notifications Pesapal sent with any processing error (raw payloads are never shown).
- **Needs review (`/admin/billing/review`):** the queue of payments a human must handle. A payment lands here when its amount or currency did not match the order (plan not changed), when an upgrade was paid after the billing period had already moved on (not applied), or when Pesapal reversed it (subscription cancelled). Each item explains what happened and what to do, with the confirmation code to look up in Pesapal. **Mark as reviewed** records who reviewed it, when, and an optional note (max 500 characters); a payment can be reviewed once. "Show reviewed" lists the history.

### Jobs (`/admin/jobs`)

Background job monitoring with two tabs:

**Recent tab:** the 50 most recent jobs (generation + publish) across all users, 20 per page with pagination
**Failed tab:** the 50 most recent jobs with `status: "failed"`, 20 per page with pagination

Columns: type, video title, user, status, error message, timing

### Quota (`/admin/system/quota`)

Today's YouTube API quota usage: units consumed per user (heaviest first) and the platform total against the YouTube Data API daily limit (10,000 units).

### Storage (`/admin/system/storage`)

Total stored video size (the sum of recorded file sizes) and a per-user breakdown (video count, bytes, plan).

### Health (`/admin/system/health`)

- **Storage health:** healthy / missing / unchecked counts for all `ready` and `scheduled` videos, the list of videos with a missing Cloudinary file, and a "Check All Users" button (time-boxed to about 25 seconds per click; click again to continue)
- **YouTube token health:** connected channels by OAuth status, listed with channel, user, primary/secondary role and status, and a "Recheck All" button (also time-boxed)

### Usage (`/admin/usage`)

Monthly usage metering across all users with:
- Summary cards: Free users, Pro users, Elite users, users at a plan limit
- Plan filter: All / Free / Pro / Elite
- At-limit filter: shows only users who have reached a capped monthly limit
- Table columns: user, plan, uploads, metadata, Veo and AI messages (each as used / limit)

### Messages (`/admin/contact`)

Submissions from the public contact form (new / read), with mark-as-read and delete.

### Settings (`/admin/settings`)

Platform-level API key and billing configuration. Three cards:

**DeepSeek — AI Assistant:**
- Password input to set/replace the API key
- Show/hide toggle
- Save button
- Test button: calls the DeepSeek API with a minimal prompt and shows success or error inline
- "Key is configured" indicator when a key is saved

**Gemini — Metadata Generation:**
- Same UI as DeepSeek card
- Falls back to the `GEMINI_API_KEY` env var if no key is set in the database
- Test button: calls Gemini 2.5 Flash with a minimal prompt and shows the result

**Pesapal — Billing:**
- Consumer key and consumer secret (stored encrypted; only a masked hint of the key is shown)
- Environment switch: sandbox / live (changing the environment or key clears the IPN registration)
- "Register IPN" button, which registers the IPN URL with Pesapal; the IPN URL and customer return URL are displayed
- Falls back to `PESAPAL_CONSUMER_KEY` / `PESAPAL_CONSUMER_SECRET` env vars if nothing is saved in the database

Keys are stored encrypted in the `platform_settings` singleton table. Key values are never sent to the browser — only boolean "is set" flags and masked hints. Server-side code retrieves and decrypts the values for use by AI and billing code.


---

## Pricing Tiers

> Note: Platform costs are mainly Gemini (metadata, captions, thumbnails, and Veo unless a Vertex AI service account is used) and DeepSeek. Veo generation is paid by the platform, so it is capped per plan. Email is BYOK.

### What is enforced

These limits are enforced in code (`src/server/lib/usage.ts`, the Cloudinary signing route and the channel and assistant checks). Monthly counters reset by calendar month (UTC).

| | Free | Pro | Elite |
|---|---|---|---|
| Video uploads / month | 10 | Unlimited | Unlimited |
| AI metadata generations / month | 5 | Unlimited | Unlimited |
| Veo video generations / month | 0 | 5 | Unlimited |
| AI assistant messages / month | 0 (no assistant) | 200 | 1,000 |
| Max upload file size | 100 MB | 500 MB | 2 GB |
| Connected YouTube channels | 1 | Multiple | Multiple |

Hitting a limit returns a `PLAN_LIMIT_EXCEEDED` error that the UI turns into an upgrade message.

### Features and plan copy

Auto-publish, scheduling, the content calendar, analytics, Idea Vault, Content Intelligence and Discord / Telegram / email notifications are not plan-gated in code; they work on every plan. The billing page's plan cards list the auto-publish queue, full analytics and Discord / Telegram / email alerts under Pro, but only the limits in the table above are enforced. There are no Elite-only extras such as priority metadata queueing or extended analytics history; bulk metadata generation (on `/generate`) is available on every plan.

### Prices

Prices come from server configuration and are shown to users from `billing.getStatus`, so the browser always matches what Pesapal will charge:

- **Pro:** `PLAN_PRO_PRICE` per 30-day period, default **19** (a legacy `NEXT_PUBLIC_PRO_PRICE_USD` is still read as a fallback)
- **Elite:** `PLAN_ELITE_PRICE`, which has **no default** — Elite cannot be purchased until the owner sets it. Admins can still grant Elite by hand from the user detail page
- Charge currency: `PESAPAL_CURRENCY` (default USD)

### Billing

**Route:** `/billing` (plan cards, usage meters, renewal and payment history). Payments are available once Pesapal credentials are saved, the IPN is registered, and `NEXT_PUBLIC_APP_URL` is set; until then the page says online payments are not switched on.

**Model:** Pesapal API 3.0. Reelcast owns renewals: every charge is a one-off hosted-checkout order (M-Pesa, Airtel Money, cards) that buys one 30-day period. There are no automatic debits.

**Subscription states:** `approval_pending` (awaiting first payment) → `active` → `past_due` (period ended unpaid; 3-day grace) → `expired`, or `cancelled`. The `users.plan` column is the effective entitlement; `users.plan_source` (`default` / `subscription` / `admin`) records who set it, so an admin-granted plan is never wiped by a lapse and cannot be changed through self-serve billing.

**User actions:**
- **Subscribe / renew:** open a hosted checkout. Renewal opens 3 days before the period ends; the `billing.renewal` sweep creates the renewal order and a reminder
- **Upgrade:** pay the prorated difference now (differences under 1.00 are scheduled for the next renewal instead)
- **Downgrade / switch to Free:** takes effect at the end of the paid period
- **Cancel / resume:** stop renewing, keeping access until the period ends; resume while the period or grace is still running

**Payment integrity:** the customer return (`/api/billing/callback`) and the IPN (`/api/webhooks/pesapal/ipn`) never grant access on their own. Both re-fetch the order status from Pesapal (`GetTransactionStatus`), check the merchant reference, amount and currency, and apply a completed payment exactly once (`payment_orders.applied_at`). The `billing.reconcile` sweep polls unpaid orders older than 10 minutes so a lost IPN cannot strand a payment. Raw provider notifications are kept in `payment_events`.

---

## API Key Model

The platform distinguishes between three types of credentials:

### Platform Keys (Admin-managed)

Stored encrypted (AES-256-GCM) in the `platform_settings` singleton table. Set by the admin via Admin > Settings. Never exposed to the client — only booleans and masked hints are sent to the browser. Server-side code decrypts them for use.

| Key | Service | Purpose | Cost bearer |
|-----|---------|---------|-------------|
| `deepseek_api_key` | DeepSeek Chat | AI assistant (Pro/Elite users) | Platform |
| `gemini_api_key` | Gemini Developer API | Metadata, captions, thumbnails; also Veo when Vertex AI is not configured | Platform |
| `pesapal_consumer_key`, `pesapal_consumer_secret` | Pesapal | Billing (with the environment and registered IPN stored alongside) | n/a |

The Gemini key falls back to the `GEMINI_API_KEY` environment variable if not set in the database; Pesapal credentials fall back to `PESAPAL_CONSUMER_KEY` / `PESAPAL_CONSUMER_SECRET`. Veo can instead use a Vertex AI service account from environment variables (see below).

### BYOK — User's Own Key

Users provide these in their own settings. They are stored encrypted per user, never sent back to the browser (only `has*` flags), and the cost is borne by the user.

| Key | Service | Purpose |
|-----|---------|---------|
| `resend_api_key` | Resend | Email notifications |
| `deepseek_api_key` (user settings) | DeepSeek | Overrides the platform key for the assistant; supported by the server, no field in the UI yet |

Telegram uses the platform's bot token with the user's chat ID; Discord uses the user's own webhook URL.

### Environment Variables

Used for infrastructure-level secrets and configuration that are not user-configurable (see `.env.example`):

- **Supabase:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **Database:** `DATABASE_URL` (transaction pooler, port 6543, used by the app), `DATABASE_URL_DIRECT` (session pooler, port 5432, used by migrations and `scripts/db-cron.ts`)
- **App secrets:** `APP_ENCRYPTION_KEY` (32 random bytes, base64; encrypts YouTube tokens, BYOK keys and payment credentials), `CRON_SECRET` (protects `/api/cron/tick`)
- **App:** `NEXT_PUBLIC_APP_URL` (public URL; Pesapal IPN and callback URLs are built from it)
- **Cloudinary:** `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- **Google OAuth (YouTube):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- **Gemini:** `GEMINI_API_KEY` (fallback if not set in `platform_settings`); optional Vertex AI for Veo: `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (default `us-central1`)
- **Billing:** `PESAPAL_CURRENCY` (default USD), `PLAN_PRO_PRICE` (default 19), `PLAN_ELITE_PRICE` (unset = Elite not purchasable); optional fallbacks `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`
- **Telegram:** `TELEGRAM_BOT_TOKEN` (optional)
- **Product analytics:** `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` (optional; unset key = disabled)

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

**COOP note:** Set to `same-origin-allow-popups` (not `same-origin`) so a Google OAuth popup window keeps working (per the comment in `next.config.ts`).

**CSP note:** Content-Security-Policy is intentionally omitted — it requires careful per-domain tuning for Supabase, Cloudinary (direct uploads and media), Google APIs and avatars, YouTube thumbnails and PostHog. Deferred for a later iteration.

**COEP note:** `Cross-Origin-Embedder-Policy` is omitted because it would block cross-origin images and media (Cloudinary, YouTube thumbnails, Google avatars) unless every origin sent matching CORP/CORS headers.

### Security.txt

`public/.well-known/security.txt` — contact information for responsible disclosure:

```
Contact: mailto:manb10291@gmail.com
Preferred-Languages: en
Expires: 2027-08-06T00:00:00.000Z
```

### Admin Access Control

Every admin RPC function is declared `auth: "admin"`; the dispatcher rejects non-admins with `FORBIDDEN` before the handler runs, and admin status is read from `users.is_admin` in the database on every call (never from a token). The `/admin` layout also redirects non-admins on the server. The check is enforced server-side — no client-side gating alone. Admin user and job responses are explicit column projections: no tokens, API keys or webhook URLs.

### Database Lock-down

Every table has row-level security enabled with **no policies**, and all grants to the Supabase `anon` and `authenticated` roles are revoked (including default privileges for future tables). Only the server's own database connection reads or writes data, so the Supabase API can never expose tokens or keys. Access control happens in the RPC layer. New tables must be locked down the same way in their migration.

### Secrets and DTOs

- YouTube access/refresh tokens, user BYOK keys, platform keys, Pesapal credentials and YouTube upload-session URIs are encrypted at rest with AES-256-GCM (`src/server/crypto.ts`, key `APP_ENCRYPTION_KEY`)
- Rows from `users`, `settings`, `youtube_channels` and `platform_settings` are never returned raw. DTO builders return `has*` flags, masked hints and channel summaries instead of secrets
- Error text is redacted (API keys, bearer tokens) before it is stored on a row or shown to a user

### Request Safety

- **CSRF and size:** `/api/rpc` accepts only same-origin JSON requests — it rejects (403) any request whose `Sec-Fetch-Site` header is present and is not `same-origin` or `none`, and any request whose `Origin` header is present but is not one of the app's own hosts (the `Host` / `X-Forwarded-Host` header, the request URL, or `NEXT_PUBLIC_APP_URL`); it requires exactly `Content-Type: application/json` (optional `charset=utf-8`; anything else is 415) and caps the body at 1 MiB (413, enforced while the stream is read, so a missing or false `Content-Length` does not help). The rules are in `src/server/rpc/request-guard.ts`
- **OAuth:** the YouTube flow uses a random one-time `state` cookie
- **Cron:** `/api/cron/tick` requires `CRON_SECRET` (compared in constant time)
- **Payments:** Pesapal IPN and return calls are never trusted; status is re-verified with Pesapal before access is granted
- **Validation:** every RPC input is validated with zod; unknown settings keys are rejected
- **SSRF:** the server fetches video files only from the app's own Cloudinary delivery URLs over https, and posts only to genuine Discord webhook hosts
- **Uploads:** direct-to-Cloudinary uploads are signed per request; the server fixes the per-user folder, a random public id, video-only formats and no overwrite, plus a plan-based `max_file_size`
- **Abuse:** the public contact form is limited to 3 messages per email and 60 messages overall per hour

### Privacy

YouTube-derived analytics are deleted when a channel is disconnected or its access is revoked. PostHog (when enabled) identifies users by internal ID only, honours Do-Not-Track, and does no session recording.

---

## Data Model

All tables live in Supabase Postgres. The schema is defined in `src/db/schema.ts` (Drizzle) and applied by the SQL migrations in `drizzle/`. There are 22 tables.

**Conventions:** ids are UUIDs; columns are `snake_case`; enums are `text` with a CHECK constraint; timestamps are `timestamptz`; the RPC layer converts them to epoch milliseconds. Secrets are stored encrypted (see [Security](#security)). Every table is locked down with RLS and no API-role grants. Deleting a user cascades to all of their rows.

### `users`

| Column | Type | Description |
|-------|------|-------------|
| `id` | uuid | Supabase auth user id (FK to `auth.users`, `ON DELETE CASCADE`) |
| `email` | text | Unique case-insensitively (`lower(email)`) |
| `name`, `image_url` | text? | From the Google profile metadata |
| `is_admin` | boolean | Admin flag (default false) |
| `plan` | enum | `free` / `pro` / `elite` — effective entitlement; set only by billing code or an admin |
| `plan_source` | enum | `default` / `subscription` / `admin` — who set `plan` |
| `created_at`, `updated_at` | timestamptz | |

**Indexes:** unique `lower(email)`, `created_at`. YouTube connection state is not on this table; see `youtube_channels`.

### `youtube_channels`

| Column | Type | Description |
|-------|------|-------------|
| `user_id` | uuid | Owner |
| `channel_id` | text | YouTube channel id — unique across all users |
| `channel_name` | text? | Human-readable channel name |
| `access_token` | text | Encrypted |
| `refresh_token` | text? | Encrypted |
| `token_expiry` | timestamptz | Access token expiry |
| `oauth_status` | enum | `connected` / `token_expired` / `revoked` / `unknown` |
| `is_primary` | boolean | The channel used by default |

**Indexes:** unique `channel_id`; `user_id`; partial unique `(user_id) WHERE is_primary` (at most one primary channel per user).

### `videos`

| Column | Type | Description |
|-------|------|-------------|
| `user_id` | uuid | Owner |
| `title`, `description`, `tags` | text, text?, text[]? | Working metadata |
| `status` | enum | `draft` / `queued` / `generating` / `ready` / `scheduled` / `publishing` / `published` / `failed` |
| `source_type` | enum? | `upload` or `generate` |
| `raw_file_key` | text | Cloudinary URL of the source file (historical column name) |
| `raw_file_size` | bigint | File size in bytes |
| `processed_file_key` | text? | Cloudinary URL of the processed file (used instead of the raw one when set) |
| `thumbnail_url`, `thumbnail_generated_url` | text? | Poster, and the AI-suggested thumbnail |
| `duration` | double? | Seconds |
| `ai_title`, `ai_description`, `ai_tags` | text? | AI-generated metadata |
| `captions_vtt` | text? | AI-drafted WebVTT captions |
| `ai_config` | jsonb? | Veo generation config (model, prompt, resolution, ...) |
| `veo_operation_name`, `veo_operation_done` | text?, boolean? | Veo operation tracking |
| `youtube_channel_id` | text? | YouTube channel id to publish to (primary channel when null) |
| `privacy_status` | enum? | `private` / `public` / `unlisted` |
| `publish_as` | enum? | `short` or `video` |
| `publish_order` | integer? | Position in the publish queue |
| `scheduled_publish_at` | timestamptz? | Requested publish time — the source of truth for scheduled publishing |
| `metadata_scheduled_at` | timestamptz? | When scheduled AI metadata generation should run |
| `published_video_id`, `published_at` | text?, timestamptz? | YouTube video id and publish time |
| `cloudinary_deleted_at` | timestamptz? | Set once the Cloudinary files were removed after publishing |
| `storage_missing`, `storage_checked_at` | boolean?, timestamptz? | Result of the last storage health check |

**Indexes:** `(user_id, created_at)`, `(user_id, status)`, partial `scheduled_publish_at WHERE status = 'scheduled'` (used by the due-schedules sweep), `created_at`, partial `(user_id, created_at DESC) WHERE scheduled_publish_at IS NOT NULL`, partial `metadata_scheduled_at WHERE NOT NULL`.

### `video_metadata_versions`

Previous AI metadata of a video (`ai_title`, `ai_description`, `ai_tags`, `saved_at`), saved on each regeneration; the last 10 per video are kept. Cascade-deleted with the video. **Index:** `(video_id, saved_at)`.

### `jobs`

User-visible background work (Veo generation, YouTube publish).

| Column | Type | Description |
|-------|------|-------------|
| `user_id`, `video_id` | uuid | Owner and target video |
| `type` | enum | `generation` or `publish` |
| `status` | enum | `pending` / `processing` / `completed` / `failed` |
| `error` | text? | Error message if failed |
| `started_at` / `completed_at` | timestamptz? | Timestamps |
| `metadata` | jsonb? | Run state: Veo poll counters, the encrypted YouTube upload session and progress, the run lease |
| `run_at`, `attempts`, `max_attempts`, `locked_at` | | Queue fields (claimable when `pending` and `run_at <= now()`; default 3 attempts) |

**Indexes:** partial claim index `run_at WHERE status = 'pending'`, `(user_id, created_at)`, `video_id`, `created_at`, `(status, created_at)`, and a partial unique index on `(video_id, type) WHERE status IN ('pending', 'processing')` — at most one active job of a type per video.

### `tasks`

Internal task queue (no UI): `kind` (`autoPublish.run`, `metadata.generate`, `digest.batch`, `analytics.ingestChunk`), `payload` (jsonb), optional `user_id`, `status` (`pending` / `running` / `done` / `failed` / `cancelled`), `run_at`, `attempts`, `max_attempts`, `locked_at`, `last_error`, `dedupe_key`. **Indexes:** partial claim index on `run_at`, and a partial unique index on `dedupe_key` while the task is `pending` or `running`.

### `job_schedules`

Bookkeeping for periodic sweeps: `name` (primary key), `last_run_at`, `lease_until` (so a crashed sweep is retried after the lease expires), `last_error`. The tick claims a sweep by atomically advancing `last_run_at`. The weekly digest also stores per-user, per-week marker rows here (`digest:<userId>:<week>`) so a digest is sent at most once.

### `settings`

One row per user (unique `user_id`). Stores all user preferences, grouped:

- **Notifications:** `notifications_enabled` (master switch), per-event toggles `notify_on_publish_success`, `notify_on_publish_failure`, `notify_on_metadata_ready`, `notify_on_weekly_digest`, `notify_on_storage_warning`, `telegram_chat_id`, `discord_webhook_url`, `telegram_message_template`, `discord_message_template`, `email_notifications_enabled`, `email_from_address`, `resend_api_key` (encrypted)
- **Keys:** `deepseek_api_key` (encrypted BYOK)
- **Metadata defaults:** `ai_auto_generate`, `ai_generate_title`, `ai_generate_description`, `ai_generate_tags`, `ai_tone`, `ai_language`, `ai_description_length`, `ai_guidelines`, `humanize_writing`
- **Brand memory:** `ai_niche`, `ai_target_audience`, `ai_brand_voice`, `ai_forbidden_words`, `ai_cta_preferences`
- **Veo defaults:** `veo_model`, `veo_resolution`, `veo_aspect_ratio`, `veo_duration_seconds`, `veo_generate_audio`, `veo_enhance_prompt`, `veo_person_generation`, `veo_number_of_videos`
- **Auto-publish:** `auto_publish_enabled`, `auto_publish_interval_ms`, `auto_publish_count`, `auto_publish_privacy`, `auto_publish_next_at`, `auto_publish_time_slots` (int[] of local hours), `auto_publish_timezone_offset` (hours from UTC, may be fractional)
- **Other:** `competitor_channel_ids` (text[]), and legacy generation presets (`ai_preset`, `default_quality`, `default_aspect_ratio`, `default_captions`, `default_background_music`)

**Indexes:** unique `user_id`; partial `auto_publish_next_at WHERE auto_publish_enabled`.

### `generations`

Records each Veo generation attempt: `user_id`, `video_id`, `model`, `prompt`, `negative_prompt`, `resolution`, `aspect_ratio`, `duration_seconds`, `generate_audio`, `status` (`submitted` / `processing` / `completed` / `failed`), `veo_operation_name`, `output_video_url`, `thumbnail_url`, `error`, `generation_time_ms`. **Indexes:** `(user_id, created_at)`, `video_id`.

### `notifications`

In-app notification inbox. Each row has a title, message, type (`info` / `success` / `warning` / `error`), `is_read` flag and an optional in-app `link`. **Indexes:** `(user_id, created_at)` and a partial index on unread rows.

### `video_analytics`

Lifetime-metric snapshots per video, one row per `(video_id, day)` (unique), where `day` is the UTC calendar day of the fetch. Populated: `views`, `watch_time_minutes`, `avg_view_duration_sec`, `likes`, `comments`, `subscribers_gained`. The columns `impressions`, `ctr`, `estimated_revenue`, `rpm`, `cpm`, `traffic_source_search`, `traffic_source_suggested` and `traffic_source_external` exist but are never written. **Indexes:** unique `(video_id, day)`, `(user_id, day)`, `(user_id, video_id, day)`.

### `video_daily_stats`

Per-day metrics ingested from the YouTube Analytics API (deltas, not lifetime totals): `views`, `watch_time_minutes`, `avg_view_duration_sec`, `likes`, `comments`, `subscribers_gained`, `subscribers_lost`, plus nullable `impressions`, `ctr`, `estimated_revenue` that nothing populates. **Indexes:** unique `(video_id, day)`, `(user_id, day)`.

### `youtube_quota_usage`

Daily YouTube Data API quota tracking per user: `units_used` per `(user_id, date)` (unique, UTC day).

### `usage_ledger`

Monthly plan usage counters. One row per `(user_id, month)` (unique, month as `YYYY-MM`). Counters: `videos_uploaded`, `metadata_generated`, `veo_generated`, `ai_messages_used`. Limits are enforced atomically when a unit is consumed (`consumeQuota`: increment and limit check are one SQL statement, so concurrent requests cannot both slip under a limit).

### `ideas`

Idea Vault entries: `title`, `notes`, `tags`, `status` (`concept` → `in_production` → `published`), `scheduled_generate_at`, and `linked_video_id` (set to null if the video is deleted). **Index:** `(user_id, created_at)`.

### `ai_sessions` and `ai_messages`

AI assistant conversation history. A session has a `title` and `last_message_at`; messages store `role` (`user` / `assistant`) and `content` (and a reserved `tool_calls` jsonb column). Messages cascade-delete with their session. **Indexes:** `(user_id, last_message_at)` on sessions; `(session_id, created_at)` and `user_id` on messages.

### `platform_settings`

Singleton table (`id = 1`, enforced by a CHECK constraint). Stores `deepseek_api_key`, `gemini_api_key`, `pesapal_consumer_key`, `pesapal_consumer_secret` (all encrypted), `pesapal_environment` (`sandbox` / `live`), and the registered `pesapal_ipn_id` / `pesapal_ipn_url`. Key values are never sent to the client.

### `contact_submissions`

Messages from the public contact form: `name`, `email`, `subject`, `message`, `status` (`new` / `read`). **Index:** `(status, created_at)`.

### `subscriptions`

| Column | Type | Description |
|-------|------|-------------|
| `user_id` | uuid | Owner |
| `plan` | enum | `pro` / `elite` |
| `status` | enum | `approval_pending` / `active` / `past_due` / `cancelled` / `expired` |
| `provider` | enum | `pesapal` |
| `period_start`, `period_end` | timestamptz? | The current paid 30-day period |
| `grace_until` | timestamptz? | Access continues until this instant after a missed renewal |
| `cancel_at_period_end` | boolean | Stop renewing |
| `pending_plan` | enum? | Plan change (downgrade) applied at period end |

**Indexes:** `(user_id, created_at)`, partial unique `(user_id)` while the status is `approval_pending`, `active` or `past_due` (one live subscription per user), and partial `period_end` for `active` / `past_due`.

### `payment_orders`

One row per Pesapal order (one-off charge): `user_id`, `subscription_id`, `merchant_ref` (our unique order id sent to Pesapal), `order_tracking_id`, `purpose` (`initial` / `renewal` / `upgrade`), `plan`, `amount` (numeric 12,2), `currency`, `status_code` (0 pending, 1 completed, 2 failed, 3 reversed), `status_text`, `confirmation_code`, `payment_method`, `redirect_url`, and `applied_at` — set exactly once when a completed payment has been applied to the subscription. **Indexes:** unique `merchant_ref`, unique `order_tracking_id` (when set), `(user_id, created_at)`.

### `payment_events`

Raw provider notifications kept for audit and replay: `provider`, `order_tracking_id`, `merchant_ref`, `notification_type`, `payload` (jsonb), `received_at`, `processed_at`, `error`. **Index:** `(order_tracking_id, received_at)`.

---

## Deployment

### Stack

- **App (frontend + API routes + job runner endpoint):** any Node host that can run Next.js. It is currently linked to Vercel (Hobby plan: ~300-second function limit, non-commercial use only). Vercel's own cron is not used — Supabase pg_cron drives the job runner
- **Database:** Supabase Postgres
- **Auth:** Supabase Auth
- **File storage and video processing:** Cloudinary

### Environment

All secrets are set as environment variables on the host (and in `.env.local` for development, copied from `.env.example`). No secrets are committed to the repository. See [Environment Variables](#environment-variables).

### Development

```bash
bun install
cp .env.example .env.local   # then fill in the values
bun run db:migrate           # apply migrations (uses DATABASE_URL_DIRECT)
bun run dev                  # Next.js (+ in-process job runner every 5 s if DEV_TICK=1)
bun run check                # typecheck + lint
bun run test <file>          # bun test (DB-backed, slow because the database is remote)
```

Always use `bun` — never `npm` or `yarn`.

### Production build and first-time setup

```bash
bun install
bun run build                # Next.js production build
bun run db:migrate           # apply pending migrations to the production database
bun --env-file=.env.local scripts/db-cron.ts https://your-domain.example   # once, and again if the URL changes
```

`scripts/db-cron.ts` enables the `pg_cron`, `pg_net` and `supabase_vault` extensions, stores `CRON_SECRET` in Supabase Vault, and schedules `reelcast-tick` every minute to call `GET /api/cron/tick`. `--remove` unschedules it. Then, in Admin > Settings, save the Pesapal credentials and register the IPN.

### Database Schema Changes

After any change to `src/db/schema.ts`:
1. Run `bun run db:generate` to create a SQL migration in `drizzle/`
2. Review the generated SQL; a new table must also be locked down (RLS enabled, no API-role grants — copy the pattern in `drizzle/0003_security_job_schedules.sql`)
3. Run `bun run db:migrate` (and `bun run db:check` to verify the migration history)
4. Commit the schema change and the migration together

### Crons

Periodic duties are **sweeps**, run by the job runner (there is no separate cron system). Each sweep runs at most once per interval across all workers (claimed through `job_schedules`). With the runner ticking every minute, a sweep's real cadence is its interval rounded up to the next tick.

| Sweep | Interval | What it does |
|-------|----------|--------------|
| `publish.dueSchedules` | 1 minute | Turns every due `scheduled` video into a `publishing` video with a publish job |
| `publish.reconcile` | 5 minutes | Repairs videos stuck in `publishing` with no live job (15+ minutes) |
| `oauth.health` | 6 hours | Probes every connected YouTube channel (time-boxed to 40 seconds; least recently checked first) |
| `weekly-digest` | 15 minutes | Acts only in the Sunday 08:00–08:59 UTC window: enqueues one `digest.batch` task per ISO week (20 users per batch, once per user per week) |
| `billing.renewal` | 15 minutes | Creates the renewal order and reminder for periods ending within 3 days |
| `billing.expiry` | 15 minutes | `active` → `past_due` (3-day grace) → `expired`, downgrading only subscription-sourced plans |
| `billing.reconcile` | 5 minutes | Polls Pesapal for unpaid orders older than 10 minutes; purges unmatched events |
| `analytics.dailyIngest` | 6 hours | Starts the chunked per-day analytics ingest (`analytics.ingestChunk` tasks, 5 users per chunk) |

Auto-publish is not a sweep: each user's `autoPublish.run` task reschedules itself for the next slot.
