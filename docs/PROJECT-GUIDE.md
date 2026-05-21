# ReelCast — Project Guide

## What We're Building

ReelCast is a cloud-native web application that takes a content creator from raw footage to a live YouTube video with as little manual effort as possible. The core premise is simple: a user uploads a raw video, the platform runs it through an AI engine that enhances and finalises it, generates all the YouTube metadata (title, description, tags), and then publishes the finished video directly to their connected YouTube channel — all in the background, on their schedule.

This document serves as the authoritative reference for what the product is, how it works, what each part of the system is responsible for, and how everything connects. It should be the first thing anyone reads before touching the codebase.

---

## The Problem Being Solved

Content creators spend a disproportionate amount of time on two things that should be invisible: post-production and distribution. Editing raw footage into a polished video, writing metadata, scheduling uploads, and manually pushing files to YouTube are all repetitive, time-consuming tasks that don't require creative judgment — they just require time.

ReelCast compresses all of that into a single automated pipeline. The creator's only job is to upload the raw material and set their preferences. Everything else — enhancement, rendering, metadata generation, and publishing — happens without them.

---

## Core Concepts

Before getting into features and flows, these are the foundational concepts the entire product is built around:

**Draft** — Any video that has been uploaded but not yet processed or published. Drafts sit in a holding state until the user triggers generation, either immediately or on a schedule. Nothing happens to an uploaded video automatically.

**Generation** — The AI processing step. A generation job takes a draft video, runs it through the configured AI engine, and produces a finalised, publish-ready video file along with AI-suggested metadata (title, description, tags). Generation runs entirely in the cloud.

**Publish** — The act of transferring the finalised video directly to the user's connected YouTube channel via the YouTube Data API. The user never downloads the file or touches YouTube manually.

**Job** — Any background task in the system: a generation job or a publish job. Jobs can be triggered immediately or scheduled for a future time. Each job has a status that updates in real time.

**Connected Channel** — A user's YouTube channel, linked to the platform via OAuth during onboarding. The platform stores the OAuth token securely and uses it on the user's behalf to perform uploads. The user can disconnect and reconnect their channel at any time from settings.

**Connected Telegram** — A user's Telegram account, linked via a bot token flow. Once connected, the platform sends the user Telegram notifications for key job events (generation complete, publish success, publish failure).

---

## Full User Flow

### Onboarding

A new user signs up via Clerk. During onboarding they are prompted to connect two things: their YouTube channel via Google OAuth, and optionally their Telegram account for notifications. Both can also be done later from Settings. The YouTube channel connection is required before any publish job can be triggered.

### Uploading a Video

The user navigates to the Upload page and selects a raw video file from their device. The file is uploaded directly to Cloudflare R2 via a presigned URL — it never passes through the application server. Once the upload completes, a draft record is created in Convex with the file reference and the upload is visible in the Drafts library.

### Configuring a Video

From the draft's detail page, the user can configure how the AI should process the video. This includes selecting a style preset, enhancement level, whether to generate captions, background music preferences, output quality, and any other generation parameters. These settings default to whatever the user has saved as their global defaults in Settings but can be overridden per video.

### Triggering Generation

The user can trigger generation immediately or schedule it for a specific date and time. When triggered, a generation job is created and queued in Convex. The job picks up the raw file from R2, sends it to the AI engine, and when processing is complete, stores the finalised video back in R2. The video's status updates in real time on the frontend via Convex's live query subscriptions. When generation completes, the AI engine also returns a suggested title, description, and set of tags which are saved against the video and pre-populated in the publish form.

### Reviewing AI Metadata

Before publishing, the user sees the AI-generated title, description, and tags on the video detail page. These are fully editable — the user can accept them as-is, modify them, or replace them entirely. Whatever is saved at publish time is what gets sent to YouTube.

### Publishing to YouTube

Once a video has been generated, the user can publish it immediately or schedule it for a specific time. Scheduling uses Convex's native scheduled functions — no external cron service is needed. When the publish job runs, a Convex action calls the YouTube Data API using the user's stored OAuth token, uploads the finalised video from R2, and applies the confirmed metadata. The user never interacts with YouTube directly. On completion (or failure), a Telegram notification is sent if the user has connected their Telegram account.

### Chained Scheduling

The user can set up a fully automated pipeline: schedule generation for a specific time, and set the video to publish automatically as soon as generation completes. This means a user can queue an entire week's content in one session and walk away.

---

## Features

### Authentication & User Management

Handled entirely by Clerk. Users can sign up with email or OAuth providers. Clerk manages sessions, tokens, and user identity. The Convex database stores additional user data (connected channel info, Telegram connection, AI settings preferences) keyed to the Clerk user ID.

### Video Uploads & Draft Library

Raw video files are uploaded client-side directly to Cloudflare R2 using presigned URLs generated by a Convex action. This keeps large file transfers off the application server entirely. Once uploaded, the video appears in the user's Drafts library with a status of `draft`. The library shows all videos and their current pipeline status at a glance.

### AI Video Generation

The AI engine processes the raw video in the cloud and returns a finalised video file. The specific AI provider is configurable and abstracted behind a service interface so it can be swapped without affecting the rest of the pipeline. Generation is handled as a Convex action, with the job status written back to the database in real time. The engine also returns AI-generated metadata alongside the processed video.

### AI-Generated Metadata

When a generation job completes, the AI engine returns a suggested YouTube title, description, and tag set based on the content of the video. These are stored against the video record and pre-filled in the publish form. The user reviews and edits them before confirming the publish. Metadata generation is not a separate step — it happens as part of every generation job automatically.

### YouTube Publishing

Publishing is a Convex background action that calls the YouTube Data API v3 on behalf of the user. It retrieves the finalised video file from R2, uploads it to YouTube, and applies the confirmed metadata. The entire process is server-side. YouTube OAuth tokens are stored securely in Convex, scoped to upload permissions only. Users can disconnect and reconnect their YouTube channel from the Settings page, which revokes and re-issues the stored token.

### Scheduling System

Both generation jobs and publish jobs can be scheduled for a future date and time using Convex's built-in scheduled functions. The two schedules are independent — a user can schedule generation for Tuesday at 9am and publishing for Wednesday at 6pm, or chain them so publishing fires automatically when generation completes. A calendar/queue view in the app shows all upcoming scheduled jobs across all videos.

### Activity & History

A dedicated History page logs every job that has run: generation jobs and publish jobs, with their outcome (success or failure), timestamps, and any error details. Failed jobs can be retried or rescheduled directly from this page. The status pipeline a video moves through is: `Draft → Generating → Ready → Scheduled → Publishing → Published` (or `Failed` at any step after Draft).

### Analytics

The Analytics page pulls performance data from the YouTube Analytics API for videos published through the platform. Metrics shown include views, watch time, likes, comments, and subscriber change per video. Data is fetched on-demand and displayed per video or aggregated across the user's channel. This gives creators a feedback loop — they can see how their published content is performing without leaving the platform.

### AI Generation Settings

Users can configure global default AI settings from the Settings page. These defaults apply to every new upload automatically. On a per-video basis, any setting can be overridden before triggering generation. Settings include output quality level, style preset, caption generation toggle, background music preferences, and output aspect ratio.

### Telegram Notifications

Users can connect their Telegram account from the Settings page. The connection flow uses a Telegram bot: the user starts a conversation with the bot, which returns a link code they paste into the platform. Once connected, the platform sends Telegram messages for the following events: generation job completed, publish job succeeded, publish job failed (with error summary). Notifications can be toggled on or off per event type from Settings.

---

## Application Pages

| Route | Purpose |
|---|---|
| `/` | Landing page — product overview and sign-up entry point |
| `/sign-in` | Clerk-powered sign-in |
| `/sign-up` | Clerk-powered sign-up and onboarding |
| `/dashboard` | Overview: recent drafts, active jobs, quick upload, pending schedules |
| `/upload` | Video upload interface with drag-and-drop support |
| `/drafts` | Full draft library with pipeline status for each video |
| `/video/[id]` | Video detail: AI config, metadata editor, generation controls, publish controls |
| `/schedule` | Calendar/queue view of all upcoming scheduled jobs |
| `/history` | Full activity log of all past generation and publish jobs |
| `/analytics` | YouTube performance data for published videos |
| `/settings` | AI defaults, YouTube channel connection, Telegram connection, account preferences |

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | Next.js (PWA) | Web application, progressively installable on desktop and mobile |
| Backend & Database | Convex | Real-time database, serverless functions, background jobs, scheduled functions |
| Authentication | Clerk | User auth, session management, Google OAuth for YouTube connection |
| Storage & CDN | Cloudflare R2 + CDN | Raw and processed video file storage, edge delivery, presigned upload URLs |
| AI Engine | TBD — abstracted | Cloud video processing, enhancement, and metadata generation |
| Publishing | YouTube Data API v3 | Video upload and metadata submission to the user's YouTube channel |
| Analytics | YouTube Analytics API | Fetching per-video and channel-level performance metrics |
| Notifications | Telegram Bot API | Delivery of job event notifications to connected user Telegram accounts |

---

## Infrastructure & Background Processing

**File uploads** happen client-to-R2 via presigned URLs. The Convex backend generates the presigned URL, the browser uploads directly to R2, and only the R2 object key is stored in the database. No video data touches the application server.

**Generation jobs** are Convex actions, queued and executed within the Convex runtime. They retrieve the raw file from R2, call the AI engine, and write the processed output back to R2. The job status is updated live in the database so the frontend reflects progress in real time without polling.

**Publish jobs** are also Convex actions. They pull the processed file from R2 and call the YouTube Data API with the user's OAuth token. The token is stored in Convex and never exposed to the client.

**Scheduled jobs** use Convex's native `ctx.scheduler.runAt()` to fire generation and publish actions at a user-defined time. No external cron service, no third-party scheduler — scheduling is handled natively within the Convex backend.

**Telegram notifications** are sent by Convex actions at the end of generation and publish jobs. The action calls the Telegram Bot API with the user's stored chat ID and a pre-formatted message. Notification delivery does not block the job — it runs as a follow-up step after the primary job resolves.

---

## Security

- YouTube OAuth tokens are stored in Convex with user-level isolation and are never returned to the client
- All video files live in private Cloudflare R2 buckets; access requires a short-lived presigned URL generated server-side
- Clerk handles all authentication — the application database stores no passwords
- Telegram chat IDs are stored per user and used only for outbound notifications; the bot does not respond to inbound messages after the initial connection flow
- All Convex mutations and actions that operate on user data validate the calling user's identity against the resource owner before executing

---

## YouTube API — Quota Awareness

The YouTube Data API v3 operates on a daily quota system (10,000 units per project by default). A single video upload costs 1,600 units, meaning the default quota supports approximately 6 uploads per day across all users. For a multi-user platform this is a hard constraint that must be planned for.

The platform addresses this in two ways. First, all publish jobs are queued and rate-limited within Convex — jobs are dispatched sequentially with awareness of remaining daily quota, not fired concurrently. Second, a quota increase request must be submitted to Google via the YouTube API Services Audit and Quota Extension Form before launch. This requires a working demo of the application, a published Privacy Policy, a published Terms of Service, and a detailed description of the use case. Google's review typically takes 3–5 business days and approval is not guaranteed, so this process should be initiated as early as possible in the build.

The YouTube Analytics API has its own separate quota and is read-only. Analytics calls are made on-demand (not on a schedule) to keep usage minimal.

---

## Folder Structure

The project is split into two root directories: `app` for the Next.js frontend and `convex` for all backend logic. This separation is enforced by Convex's own conventions and makes the boundary between client and server code explicit and hard to accidentally blur.

```
reelcast/
│
├── app/                                        # Next.js application (PWA)
│   ├── public/
│   │   ├── icons/                              # PWA icons (192x192, 512x512, maskable)
│   │   ├── manifest.json                       # PWA web app manifest
│   │   └── sw.js                               # Service worker (generated by next-pwa)
│   │
│   ├── src/
│   │   ├── app/                                # Next.js App Router
│   │   │   ├── (auth)/                         # Route group — unauthenticated pages
│   │   │   │   ├── sign-in/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── sign-up/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── layout.tsx                  # Minimal layout for auth pages
│   │   │   │
│   │   │   ├── (marketing)/                    # Route group — public landing page
│   │   │   │   ├── page.tsx                    # Landing page (/)
│   │   │   │   └── layout.tsx
│   │   │   │
│   │   │   ├── (app)/                          # Route group — authenticated app shell
│   │   │   │   ├── layout.tsx                  # App shell layout (sidebar, nav, auth guard)
│   │   │   │   ├── dashboard/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── upload/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── drafts/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── video/
│   │   │   │   │   └── [id]/
│   │   │   │   │       └── page.tsx            # Video detail — config, metadata, controls
│   │   │   │   ├── schedule/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── history/
│   │   │   │   │   └── page.tsx
│   │   │   │   ├── analytics/
│   │   │   │   │   └── page.tsx
│   │   │   │   └── settings/
│   │   │   │       ├── page.tsx                # Settings index (redirects to /general)
│   │   │   │       ├── general/
│   │   │   │       │   └── page.tsx
│   │   │   │       ├── ai/
│   │   │   │       │   └── page.tsx            # AI generation defaults
│   │   │   │       ├── youtube/
│   │   │   │       │   └── page.tsx            # YouTube channel connection
│   │   │   │       ├── telegram/
│   │   │   │       │   └── page.tsx            # Telegram account connection
│   │   │   │       └── notifications/
│   │   │   │           └── page.tsx            # Notification event toggles
│   │   │   │
│   │   │   ├── api/                            # Next.js API routes
│   │   │   │   ├── webhooks/
│   │   │   │   │   └── clerk/
│   │   │   │   │       └── route.ts            # Clerk webhook handler (user sync)
│   │   │   │   └── youtube/
│   │   │   │       └── callback/
│   │   │   │           └── route.ts            # YouTube OAuth callback handler
│   │   │   │
│   │   │   ├── layout.tsx                      # Root layout (providers, fonts, metadata)
│   │   │   ├── not-found.tsx
│   │   │   └── error.tsx
│   │   │
│   │   ├── components/
│   │   │   ├── ui/                             # Base design system components (shadcn/ui)
│   │   │   │   ├── button.tsx
│   │   │   │   ├── badge.tsx
│   │   │   │   ├── card.tsx
│   │   │   │   ├── dialog.tsx
│   │   │   │   ├── dropdown-menu.tsx
│   │   │   │   ├── input.tsx
│   │   │   │   ├── label.tsx
│   │   │   │   ├── progress.tsx
│   │   │   │   ├── select.tsx
│   │   │   │   ├── skeleton.tsx
│   │   │   │   ├── switch.tsx
│   │   │   │   ├── table.tsx
│   │   │   │   ├── tabs.tsx
│   │   │   │   ├── textarea.tsx
│   │   │   │   └── tooltip.tsx
│   │   │   │
│   │   │   ├── layout/                         # Structural layout components
│   │   │   │   ├── sidebar.tsx
│   │   │   │   ├── topbar.tsx
│   │   │   │   └── page-header.tsx
│   │   │   │
│   │   │   ├── video/                          # Video-specific components
│   │   │   │   ├── video-card.tsx              # Draft card with status badge
│   │   │   │   ├── video-status-badge.tsx      # Pipeline status pill
│   │   │   │   ├── video-uploader.tsx          # Drag-and-drop upload widget
│   │   │   │   ├── upload-progress.tsx         # Upload progress bar
│   │   │   │   ├── ai-config-form.tsx          # Per-video AI settings override form
│   │   │   │   ├── metadata-editor.tsx         # Editable title/description/tags form
│   │   │   │   └── generation-trigger.tsx      # Immediate vs scheduled generation control
│   │   │   │
│   │   │   ├── publish/                        # Publishing-specific components
│   │   │   │   ├── publish-controls.tsx        # Publish now vs schedule control
│   │   │   │   └── schedule-picker.tsx         # Date/time picker for scheduling
│   │   │   │
│   │   │   ├── schedule/                       # Schedule page components
│   │   │   │   ├── job-calendar.tsx            # Calendar view of scheduled jobs
│   │   │   │   └── job-queue-list.tsx          # List view of upcoming jobs
│   │   │   │
│   │   │   ├── analytics/                      # Analytics page components
│   │   │   │   ├── metrics-overview.tsx        # Channel-level summary cards
│   │   │   │   ├── video-metrics-row.tsx       # Per-video metrics row
│   │   │   │   └── performance-chart.tsx       # Views/watch time chart
│   │   │   │
│   │   │   ├── history/                        # History page components
│   │   │   │   ├── job-log-row.tsx             # Single job log entry
│   │   │   │   └── retry-button.tsx            # Retry/reschedule failed job
│   │   │   │
│   │   │   ├── settings/                       # Settings section components
│   │   │   │   ├── ai-defaults-form.tsx
│   │   │   │   ├── youtube-connect-card.tsx
│   │   │   │   └── telegram-connect-card.tsx
│   │   │   │
│   │   │   └── shared/                         # General-purpose shared components
│   │   │       ├── empty-state.tsx
│   │   │       ├── error-boundary.tsx
│   │   │       ├── loading-spinner.tsx
│   │   │       └── confirm-dialog.tsx
│   │   │
│   │   ├── hooks/                              # Custom React hooks
│   │   │   ├── use-upload.ts                   # Presigned URL fetch + direct R2 upload
│   │   │   ├── use-video-status.ts             # Real-time video pipeline status
│   │   │   ├── use-job-queue.ts                # Scheduled jobs live subscription
│   │   │   └── use-analytics.ts               # YouTube Analytics data fetching
│   │   │
│   │   ├── lib/                                # Shared utility and config
│   │   │   ├── convex.ts                       # ConvexProvider + ConvexWithAuth client setup
│   │   │   ├── clerk.ts                        # Clerk client config
│   │   │   ├── utils.ts                        # General utility functions (cn, formatDate, etc.)
│   │   │   ├── constants.ts                    # App-wide constants (status enums, limits)
│   │   │   └── validators.ts                   # Zod schemas for forms
│   │   │
│   │   └── types/                              # TypeScript type definitions
│   │       ├── video.ts                        # Video and draft types
│   │       ├── job.ts                          # Generation and publish job types
│   │       ├── analytics.ts                    # YouTube Analytics response types
│   │       └── settings.ts                     # User settings and AI config types
│   │
│   ├── next.config.ts                          # Next.js config (PWA, R2 image domains)
│   ├── tailwind.config.ts
│   ├── tsconfig.json
│   ├── .env.local                              # Local environment variables (never committed)
│   └── .env.example                            # Environment variable template
│
├── convex/                                     # Convex backend (co-located with app)
│   ├── schema.ts                               # Database schema — all table definitions
│   │
│   ├── users.ts                                # User record queries and mutations
│   ├── videos.ts                               # Video CRUD — queries, mutations
│   ├── jobs.ts                                 # Job queue queries and status mutations
│   ├── settings.ts                             # User AI settings queries and mutations
│   │
│   ├── actions/                                # Convex actions (can call external APIs)
│   │   ├── storage.ts                          # Generate presigned R2 upload/download URLs
│   │   ├── generation.ts                       # AI generation job — calls AI engine
│   │   ├── publish.ts                          # YouTube publish job — calls YouTube API
│   │   ├── metadata.ts                         # AI metadata generation (title/desc/tags)
│   │   ├── analytics.ts                        # Fetch YouTube Analytics API data
│   │   └── telegram.ts                         # Send Telegram notification via Bot API
│   │
│   ├── scheduled/                              # Scheduled function entry points
│   │   ├── runGeneration.ts                    # Scheduled generation job dispatcher
│   │   └── runPublish.ts                       # Scheduled publish job dispatcher
│   │
│   ├── lib/                                    # Convex-side shared utilities
│   │   ├── youtube.ts                          # YouTube API client wrapper
│   │   ├── r2.ts                               # Cloudflare R2 client wrapper
│   │   ├── ai.ts                               # AI engine client wrapper (abstracted)
│   │   ├── telegram.ts                         # Telegram Bot API client wrapper
│   │   └── auth.ts                             # Auth helper — validate caller identity
│   │
│   └── _generated/                             # Auto-generated by Convex CLI (do not edit)
│       ├── api.d.ts
│       ├── dataModel.d.ts
│       └── server.d.ts
│
├── .gitignore
├── .env.example                                # Root-level env template
├── package.json
└── README.md                                   # This document
```

### Key Structural Decisions

**Route groups `(auth)`, `(marketing)`, `(app)`** — Next.js route groups let pages share layouts without affecting the URL. The app shell layout (sidebar, topbar, auth guard) is applied only to routes inside `(app)`. Auth pages and the landing page get their own minimal layouts. This avoids conditional layout logic in a single root layout.

**`convex/lib/`** — All third-party API clients (YouTube, R2, AI engine, Telegram) live here as thin wrappers. Convex actions import from these wrappers rather than calling SDKs directly. This makes the AI provider swappable without touching action logic.

**`convex/actions/` vs `convex/scheduled/`** — Actions contain the actual logic. Scheduled functions are lightweight entry points that simply invoke the corresponding action at the right time. This keeps scheduling concerns separate from execution logic.

**`src/components/` organisation by domain** — Components are grouped by feature domain (`video/`, `publish/`, `analytics/`) rather than by type (all modals together, all forms together). This makes it easy to find everything related to a feature in one place as the codebase grows.

**`src/hooks/`** — All Convex `useQuery` and `useMutation` calls are wrapped in custom hooks rather than called directly in page components. Pages stay clean and declarative; data-fetching logic is testable and reusable.

**`.env.example`** — A committed template listing every required environment variable with placeholder values and a comment explaining each one. The actual `.env.local` is gitignored. Anyone cloning the repo knows exactly what keys to provision without reading the codebase.
