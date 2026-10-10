# ReelCast — Project Guide

## What We're Building

ReelCast is a cloud-native web application that takes a content creator from raw footage — or just an idea — to a live YouTube video with as little manual effort as possible. A creator either uploads a video or describes one in a text prompt (generated with Google Veo). AI writes the YouTube metadata (title, description, tags, captions, thumbnails), and the platform publishes the finished video directly to the creator's connected YouTube channel — all in the background, on their schedule.

This document serves as the authoritative reference for what the product is, how it works, what each part of the system is responsible for, and how everything connects. It should be the first thing anyone reads before touching the codebase. For the full feature-by-feature specification see `docs/SPEC.md`; for planned work see `docs/PRODUCT_ROADMAP.md`.

---

## The Problem Being Solved

Content creators spend a disproportionate amount of time on two things that should be invisible: producing metadata and distributing the result. Writing titles, descriptions and tags, scheduling uploads, and manually pushing files to YouTube are repetitive, time-consuming tasks that don't require creative judgment — they just require time.

ReelCast compresses all of that into a single automated pipeline. The creator's job is to supply the video (or the idea for one) and set their preferences. Everything else — metadata generation, scheduling, queueing, uploading and notifying — happens without them.

---

## Core Concepts

Before getting into features and flows, these are the foundational concepts the entire product is built around:

**Draft** — Any video that has been uploaded (or generated) but not yet published. Drafts sit in the library until the user publishes them or schedules them.

**Generation** — Two kinds of AI work share this name. *Video generation* turns a text prompt into a video with Google Veo. *Metadata generation* has Gemini analyse an uploaded video and propose its title, description and tags (and, on request, captions and a thumbnail).

**Publish** — Transferring the finished video directly to the user's connected YouTube channel via the YouTube Data API. The user never downloads the file or touches YouTube manually.

**Job** — A user-visible background task: a *generation job* or a *publish job*. A video can have at most one active job of each type at a time. A job's status moves `pending → processing → completed` (or `failed`, with an error the user can see and retry from History).

**Task** — An internal background step that users don't see directly: auto-publish batches, scheduled metadata generation, digest sending, analytics ingestion. Jobs and tasks run on the same Postgres-backed queue.

**Connected Channel** — A user's YouTube channel, linked via Google OAuth. The platform stores the OAuth tokens encrypted and uses them on the user's behalf to upload. A channel can be linked to only one ReelCast account. The free plan allows one channel; the user can disconnect and reconnect from Settings at any time.

**Notifications** — In-app notifications plus optional delivery to Telegram, a Discord webhook, and email (the user's own Resend key) for key events: generation complete, publish success, publish failure, storage warnings, and a weekly digest.

**Plan** — Free, Pro or Elite. A plan sets monthly usage limits and the maximum upload size. Pro is bought through Pesapal; Elite is assigned by an admin unless an Elite price has been configured. An admin can also grant any plan directly.

**BYOK** — "Bring your own key". Users can supply their own Resend key (for email notifications) in Settings. Everything else — Gemini and Veo, DeepSeek — runs on platform-level keys that an admin sets in Admin → Settings. (The server also accepts a personal DeepSeek key, but there is no screen for it yet.)

---

## Full User Flow

### Onboarding

A new user signs up through Supabase Auth (email/password or Google). The app creates their profile the first time they make a request. They are prompted to connect their YouTube channel via Google OAuth, and optionally Telegram, Discord or email notifications. All of it can also be done later from Settings. A connected YouTube channel is required before anything can be published.

### Path A — Upload a video

The user opens the Upload page and picks a video file. The browser asks the server for a signed upload and then sends the file **directly to Cloudinary** — it never passes through the application server. The maximum size depends on the plan (100 MB on Free, 500 MB on Pro, 2 GB on Elite). A draft record is created with the Cloudinary URL, and, if auto-generate is enabled in the user's AI settings, Gemini analyses the video and fills in the title, description and tags.

### Path B — Generate a video from a prompt

On the Generate page the user writes a prompt and chooses the Veo model, resolution, aspect ratio, duration and options. Pressing Generate creates a generation job. When the background runner starts it, one unit of the user's monthly Veo allowance is consumed and the request is submitted to Veo (the unit is given back if the submission fails). The runner then checks on the operation every 15 seconds for up to about 10 minutes, copies the finished video into Cloudinary immediately (Google deletes Veo output after two days), and marks the video ready. If generation fails, the video is marked failed and the user is notified.

### Reviewing AI Metadata

Before publishing, the user sees the AI-generated title, description and tags on the video detail page. They are fully editable — the user can accept them as-is, change them by hand (with live counters for YouTube's limits: 100 characters for the title, 5,000 bytes for the description, 500 characters across all tags), or regenerate them. Whatever is stored on the video at publish time is what gets sent to YouTube. Every value that an edit or a regeneration replaces is kept in a history (the last 10 versions). A video that is already publishing or published is locked.

### Publishing to YouTube

Once a video is ready, the user can publish it immediately ("Publish now") or schedule it for a specific time. Publishing is a background job: it streams the file from Cloudinary to YouTube using YouTube's resumable upload protocol, in 16 MiB chunks spread across as many runs as it needs, so even a 2 GB file fits inside the hosting platform's function time limit. The YouTube video ID is saved the moment YouTube returns it, before anything else happens, so a crash can never cause a second upload. Afterwards the Cloudinary copy is removed and the user is notified. On failure the job retries with backoff; the user can retry manually from History.

### Scheduling and Auto-Publish

A scheduled video is picked up by a sweep that runs every minute and turns due videos into publish jobs. Beyond one-off schedules, the user can turn on **auto-publish**: ReelCast publishes the next ready videos from the queue at a chosen interval, or at fixed time slots in the user's time zone, in the order set on the Queue page. The Schedule and Content Calendar pages show everything that is coming up, and suggest good posting times from the user's own analytics.

---

## Features

### Authentication & User Management

Supabase Auth handles sign-up, sessions and Google sign-in. ReelCast stores a profile row per user keyed by the Supabase user ID (email, name, plan, admin flag). No passwords are stored in the application database.

**Editing the profile.** On `/profile`, "Edit profile" opens a dialog to change the name and the profile picture; the email is shown but cannot be changed. A picture is chosen from a file, cropped in the browser (drag to reposition, slider to zoom) to a 512 × 512 JPEG, and uploaded straight to Cloudinary into the user's own folder (`reelcast/avatars/<user id>/`) with a signature from `/api/cloudinary/sign-avatar`. Saving calls `users.updateProfile`, which checks the name rules (1–60 characters, no control characters or `<` `>`) and re-checks the picture with Cloudinary (it must be the caller's own file, an image, JPG/PNG/WebP, at most 5 MB, 64–4096 px). A replaced or removed picture is deleted from Cloudinary.

**Deleting the account.** `/profile/delete` shows what will be removed and requires typing the account email. `users.deleteAccount` then, in this order: deletes every video file the user uploaded or generated and every profile picture from Cloudinary (all-or-nothing: if storage fails, nothing else is touched and the user can retry); revokes the YouTube grants at Google; and in one transaction deletes the contact-form messages and raw payment notifications that carry the user's data without pointing at them, then the Supabase auth user, whose `ON DELETE CASCADE` chain removes the app user and every row that belongs to it. The only admin cannot delete their account until another admin exists. Videos already published to YouTube stay on YouTube.

### Video Uploads & Draft Library

Files go from the browser straight to Cloudinary using signed upload parameters. The Drafts library lists every video with its pipeline status at a glance. The pipeline a video moves through is: `draft → queued → generating → ready → scheduled → publishing → published` (or `failed`).

### AI Video Generation (Veo)

Text-to-video with Google Veo, run as a background generation job. Generation settings (model, resolution, aspect ratio, duration, audio, prompt enhancement, person generation) default to the user's saved AI settings and can be overridden per video. Available on Pro (5 per month) and Elite (unlimited).

### AI-Generated Metadata

Gemini produces a title, description and tags for uploaded videos, and can also generate captions and a thumbnail on demand. Tone, custom guidelines and a "humanize writing" option shape the output. Settings → AI also stores language, description length, brand voice, niche, target audience, forbidden words and call-to-action preferences; brand voice, niche and audience currently inform the AI assistant, while the metadata generator does not apply language, length, forbidden-word or CTA preferences yet. Scheduled metadata generation lets a user queue it for a later time.

### YouTube Publishing

A background job calls the YouTube Data API v3 on the user's behalf using stored, encrypted OAuth tokens that are refreshed automatically. Health checks run periodically and warn the user if a token has been revoked.

### Scheduling, Queue & Auto-Publish

Per-video scheduling, a calendar view, a reorderable publish queue and auto-publish (interval or time slots). Everything is server-side and survives deploys and restarts.

### Activity & History

A History page logs every generation and publish job with its outcome, timestamps and error details. Failed jobs can be retried from there.

### Analytics

YouTube performance data per video and aggregated across the channel: views, watch time, likes, comments and subscriber change. Users can refresh on demand, and a daily background ingestion keeps per-day numbers up to date. (Click-through rate and impressions are not collected today.)

### AI Assistant

A chat assistant (DeepSeek, on the platform's key) that knows the user's recent videos, schedule and analytics. Included from the Pro plan: 200 messages per month on Pro and 1,000 on Elite.

### Idea Vault & Content Intelligence

The Ideas page stores content ideas through their lifecycle (concept → in production → published). Content Intelligence searches YouTube for trending topics, keyword opportunities and gaps against the user's channel.

### Notifications

In-app notifications, plus Telegram, Discord and email delivery, with per-event toggles and customisable message templates. A weekly digest goes out on Sundays.

### Plans & Billing

Free, Pro and Elite, with limits enforced atomically on the server. Paid plans are purchased through **Pesapal** (Elite only when an Elite price is configured) (M-Pesa, Airtel Money and cards). Each charge is a one-off order; ReelCast tracks the billing period itself, reminds the user before renewal, and gives a three-day grace period before a lapsed plan is downgraded. Plans granted by an admin are never removed by a lapsed payment.

### Admin Panel

An admin-only console with its own sidebar and routes, separate from the user app. Sections: **Overview** (what needs attention now), **People** (users, contact messages), **Content** (videos, jobs), **Money** (billing overview, subscriptions, payments, a queue of payments that need review, plan usage) and **System** (YouTube quota, storage, health, platform settings with API keys and Pesapal credentials). Every admin action is checked on the server.

---

## Application Pages

| Route | Purpose |
|---|---|
| `/` | Landing page — product overview and sign-up entry point |
| `/sign-in`, `/sign-up` | Supabase Auth sign-in and sign-up |
| `/dashboard` | Overview: recent drafts, active jobs, quick upload, pending schedules |
| `/upload` | Video upload with drag-and-drop and AI metadata |
| `/generate` | Prompt-to-video generation with Veo |
| `/drafts` | Draft library with pipeline status for each video |
| `/video/[id]` | Video detail: metadata editor, thumbnail/captions, publish and schedule controls |
| `/queue` | Reorderable publish queue and auto-publish status |
| `/schedule` | Scheduling, suggested times and auto-publish setup |
| `/content-calendar` | Calendar view of scheduled and published videos |
| `/history` | Log of all generation and publish jobs, with retry |
| `/analytics` | YouTube performance data |
| `/ideas` | Idea vault |
| `/intelligence` | Content intelligence: trends, keywords, gaps |
| `/settings` (+ `/ai`, `/general`, `/notifications`, `/telegram`, `/youtube`) | Account, YouTube connection, AI defaults, notification channels |
| `/ai-config`, `/profile` | AI defaults and profile (edit name and picture) |
| `/profile/delete` | Permanently delete the account and all of its data |
| `/billing` | Plan, usage, payments, upgrade/cancel (Pesapal) |
| `/admin/*` | Admin console with its own sidebar: overview, users, messages, videos, jobs, billing (subscriptions, payments, needs review), usage, system (quota, storage, health), settings |
| `/contact`, `/privacy`, `/terms` | Marketing and legal pages |

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | Next.js 16 (App Router), React 19, Tailwind CSS 4, TanStack Query | Web application, installable as a PWA |
| API layer | Typed RPC over `POST /api/rpc` (`src/server/rpc`) | One entry point for all browser → server calls, validated with zod |
| Database | Supabase Postgres + Drizzle ORM | All application data; migrations in `drizzle/` |
| Authentication | Supabase Auth | Sign-up, sessions, Google sign-in |
| Background jobs | Postgres job queue + Supabase `pg_cron`/`pg_net` | Publishing, generation, schedules, sweeps (no external scheduler) |
| File storage & CDN | Cloudinary | Uploaded and generated videos, thumbnails |
| AI | Google Gemini and Veo (`@google/genai`), DeepSeek | Metadata, captions, thumbnails, video generation, assistant |
| Publishing & analytics | YouTube Data API v3, YouTube Analytics API | Upload, health checks, performance data |
| Billing | Pesapal API 3.0 | Subscriptions for Pro/Elite |
| Notifications | Telegram Bot API, Discord webhooks, Resend | Event delivery |
| Product analytics | PostHog (optional) | Anonymous usage analytics, off unless configured |
| Tooling | bun, TypeScript, ESLint, `bun test` | |

---

## Infrastructure & Background Processing

**Browser to server.** Pages call server functions through a single endpoint, `POST /api/rpc`. Each function is defined once under `src/server/modules/`, validates its input, runs with the signed-in user's identity, and returns only safe, minimal data. The browser has no live subscription: writes refresh the affected data immediately, and job and queue views poll every few seconds.

**File uploads** go from the browser to Cloudinary using signed parameters from `/api/cloudinary/sign`; only the resulting URL is stored in the database. No video data touches the application server for uploads. Publishing streams the file from Cloudinary to YouTube.

**Background work** runs on a Postgres queue (`jobs` for user-visible work, `tasks` for internal steps, `job_schedules` for periodic sweeps). A single runner, `runTick()`, claims due work with `FOR UPDATE SKIP LOCKED` so many callers can run it safely at once. In production, Supabase `pg_cron` calls `/api/cron/tick` every minute (installed once with `scripts/db-cron.ts`); in development an in-process timer calls it every five seconds, so `next dev` is the only process you need. Handlers are written to be idempotent, because delivery is at-least-once; long operations such as Veo polling and YouTube uploads resume across runs instead of holding a function open.

**Periodic sweeps** include: due scheduled publishes (every minute), reconciliation of stuck publishes, OAuth health checks, the weekly digest, billing renewals/expiry/reconciliation, and daily analytics ingestion.

**Notifications** are sent as a follow-up step after the primary job resolves. A failure to notify never fails the job.

**Billing** is driven by Pesapal order notifications (IPN) and the customer return redirect. Neither is trusted on its own: each one re-checks the order status with Pesapal, and a payment is applied exactly once even if both arrive at the same time.

---

## Security

- YouTube OAuth tokens, user API keys, platform API keys and payment credentials are encrypted at rest (AES-256-GCM) and are never sent to the browser
- The database is closed to the public API: every table has row-level security enabled with no policies and no grants, so only the server's own connection can read or write
- Every server function validates its input and is scoped to the signed-in user; admin functions require the admin flag, which is always read from the database
- `/api/rpc` accepts same-origin JSON requests only; the cron endpoint requires a secret; Pesapal notifications are verified by re-querying Pesapal
- Supabase Auth handles all authentication — the application database stores no passwords
- File URLs are limited to the app's own Cloudinary account, and Discord webhooks are limited to Discord's hosts, to block server-side request forgery
- Telegram chat IDs are stored per user and used only for outbound notifications
- Uploaded files are deleted from Cloudinary after a successful publish
- Profile pictures can only be uploaded into the caller's own Cloudinary folder (the signature fixes the folder, a random id, the allowed formats and a size cap), and a picture URL is accepted only if it is exactly that kind of URL for that user and Cloudinary confirms the file
- Account deletion is complete by construction: every table that holds user data references `users(id) ON DELETE CASCADE`, and tests fail if a new table does not (or is not explicitly handled by `deleteAccount`)

---

## YouTube API — Quota Awareness

The YouTube Data API v3 operates on a daily quota system (10,000 units per project by default). A single video upload costs 1,600 units, meaning the default quota supports approximately 6 uploads per day across all users. For a multi-user platform this is a hard constraint that must be planned for.

The platform records each user's daily quota usage and shows it to admins, and publishing is queued rather than fired concurrently. In addition, a quota increase request must be submitted to Google via the YouTube API Services Audit and Quota Extension Form before launch. This requires a working demo of the application, a published Privacy Policy, a published Terms of Service, and a detailed description of the use case. Google's review typically takes 3–5 business days and approval is not guaranteed, so this process should be initiated as early as possible.

The YouTube Analytics API has its own separate quota and is read-only. Analytics are fetched on demand and by a bounded daily ingestion to keep usage low. The OAuth connection must include the `yt-analytics.readonly` scope for analytics to work.

---

## Folder Structure

Everything lives in one Next.js project. The browser-facing code is under `src/app`, `src/components` and `src/lib`; everything that runs only on the server (database, business logic, background jobs, billing) is under `src/server` and `src/db`, and is reached from the browser exclusively through the RPC layer.

```
reelcast/
│
├── src/
│   ├── app/                                    # Next.js App Router
│   │   ├── (auth)/                             # Route group — sign-in / sign-up (minimal layout)
│   │   │   ├── sign-in/page.tsx
│   │   │   └── sign-up/page.tsx
│   │   ├── (marketing)/                        # Route group — landing, contact, privacy, terms
│   │   ├── (app)/                              # Route group — authenticated app shell (sidebar, topbar)
│   │   │   ├── dashboard/  upload/  generate/  drafts/  video/[id]/
│   │   │   ├── queue/  schedule/  content-calendar/  history/
│   │   │   ├── analytics/  ideas/  intelligence/  profile/  ai-config/
│   │   │   ├── settings/                       # general, ai, notifications, telegram, youtube
│   │   │   └── billing/                        # Plan, usage, payments (Pesapal)
│   │   ├── (admin)/admin/                      # Route group — admin console with its own layout, sidebar and top bar
│   │   │   ├── page.tsx                        # Overview: what needs attention
│   │   │   ├── users/  contact/                # People (users + user detail, messages)
│   │   │   ├── videos/  jobs/                  # Content
│   │   │   ├── billing/                        # Money: overview, subscriptions/, payments/, review/
│   │   │   ├── usage/
│   │   │   ├── system/                         # quota/, storage/, health/
│   │   │   └── settings/                       # Platform API keys, Pesapal credentials
│   │   ├── auth/callback/route.ts              # Supabase OAuth code exchange
│   │   └── api/
│   │       ├── rpc/route.ts                    # Single endpoint for all browser → server calls
│   │       ├── cron/tick/route.ts              # Job runner entry point (pg_cron / any scheduler, needs CRON_SECRET)
│   │       ├── cloudinary/sign/route.ts        # Signed direct-to-Cloudinary upload parameters
│   │       ├── youtube/{connect,callback}/     # YouTube OAuth flow
│   │       ├── webhooks/pesapal/ipn/route.ts   # Pesapal payment notifications (verified by re-query)
│   │       └── billing/callback/route.ts       # Customer return from Pesapal checkout
│   │
│   ├── components/                             # UI, grouped by domain
│   │   ├── ui/                                 # Base primitives (button, card, dialog, table, ...)
│   │   ├── layout/  shared/                    # Sidebar, topbar, notifications popover, empty states, ...
│   │   ├── admin/                              # shell/ (sidebar, top bar, page frame) and billing/ (admin money screens)
│   │   ├── ai/  analytics/  billing/  calendar/  generation/  history/  publish/  schedule/  settings/
│   │   ├── providers.tsx                       # Query client, theme, Supabase auth state
│   │   └── analytics-provider.tsx              # Optional PostHog (off unless NEXT_PUBLIC_POSTHOG_KEY is set)
│   │
│   ├── lib/
│   │   ├── rpc/                                # client.ts: `api`, useQuery/useMutation/useAction; types.ts
│   │   ├── supabase/                           # Browser and server Supabase clients
│   │   └── constants.ts  utils.ts  validators.ts  eat.ts
│   │
│   ├── hooks/                                  # Small shared hooks (use-now, use-countdown)
│   ├── types/                                  # Shared UI types
│   │
│   ├── db/                                     # Server only
│   │   ├── schema.ts                           # All tables (Drizzle) — the data model
│   │   └── client.ts                           # Postgres connection (transaction pooler)
│   │
│   ├── server/                                 # Server only — never imported by client components
│   │   ├── auth.ts                             # Session → user row (ensureUser, requireUser, requireAdmin)
│   │   ├── crypto.ts                           # AES-256-GCM for secrets at rest
│   │   ├── rpc/                                # define.ts, dispatch.ts, registry.ts, errors.ts, wire.ts
│   │   ├── modules/                            # The browser-callable API, one file per domain
│   │   │   ├── videos.ts  jobs.ts  queue.ts  scheduling.ts  generations.ts  ideas.ts
│   │   │   ├── settings.ts  users.ts  youtubeChannels.ts  notifications.ts  contact.ts
│   │   │   ├── aiSessions.ts  aiMessages.ts  analytics.ts  videoAnalytics.ts  usageLedger.ts  billing.ts
│   │   │   ├── actions/                        # Calls to external APIs (publishNow, metadata, generateThumbnail, ...)
│   │   │   └── admin/                          # Admin-only functions (all require is_admin)
│   │   ├── jobs/                               # Background work
│   │   │   ├── queue.ts                        # enqueue / claim / retry / defer / recover
│   │   │   ├── tick.ts                         # runTick(): sweeps, then drain jobs and tasks
│   │   │   ├── handlers.ts  handlers/          # One handler file per domain (publish, generation, billing, analytics, system)
│   │   │   └── kick.ts                         # Ask the runner to run now after enqueueing
│   │   ├── billing/                            # Provider-agnostic core + pesapal/ adapter
│   │   └── lib/                                # Domain logic and integrations
│   │       ├── publish/  generation/  accounts/  analytics/  content/  ai/  youtube/
│   │       └── ai.ts  cloudinary.ts  youtube.ts  notify.ts  email.ts  usage.ts  dto.ts  platformKeys.ts  ...
│   │
│   ├── middleware.ts                           # Redirects signed-out visitors away from app pages
│   └── instrumentation.ts                      # Dev only: runs the job tick in-process every 5s
│
├── drizzle/                                    # SQL migrations (generated + hand-written security migrations)
├── drizzle.config.ts
├── scripts/db-cron.ts                          # One-time production setup of the pg_cron schedule
├── public/                                     # PWA manifest, service worker, icons, images
├── docs/                                       # Specification, roadmap, build plan, Veo integration notes
├── bunfig.toml                                 # Scopes `bun test` to src/
├── .env.example                                # Every environment variable, documented
└── package.json                                # Scripts: dev, build, check, db:generate, db:migrate, test
```

### Day-to-day commands

```bash
bun install
cp .env.example .env.local     # fill in the values
bun run db:migrate             # apply SQL migrations to your Supabase database
bun run dev                    # the only process you need (job runner included)
bun run check                  # typecheck + lint
bun run test <file>            # bun test, e.g. src/server/rpc/rpc.test.ts
bun run build
```

## Key Structural Decisions

**Route groups `(auth)`, `(marketing)`, `(app)`** — Next.js route groups let pages share layouts without affecting the URL. The app shell (sidebar, topbar, auth guard) is applied only to routes inside `(app)`. Auth pages and the landing page get their own minimal layouts.

**`src/server/modules/` mirrors the API** — Every browser-callable function lives in one file per domain (`videos.ts`, `settings.ts`, …), with `actions/` for functions that call external APIs and `admin/` for admin-only ones. The registry in `src/server/rpc/registry.ts` is the complete list of what the browser may call; anything not registered is internal.

**`src/server/lib/` holds the logic and the integrations** — Third-party clients (YouTube, Cloudinary, Gemini/Veo, Resend, Telegram) and domain logic (publishing, generation, accounts, analytics) live here, so modules stay thin and the code can be unit-tested without HTTP.

**`src/server/jobs/` is the only place background work is scheduled** — The queue, the runner and one handler file per domain. Nothing else schedules work.

**The database layer is private** — `src/db/` is imported only by server code. Browser code gets data through the RPC layer and typed hooks (`src/lib/rpc/client.ts`), never directly from the database.

**`src/components/` is organised by domain** — Components are grouped by feature (`publish/`, `generation/`, `billing/`, `admin/`) rather than by type, so everything related to a feature is in one place.

**`.env.example`** — A template listing every environment variable with a comment explaining each one. The real `.env.local` is gitignored, so anyone cloning the repo knows exactly what to provision.
