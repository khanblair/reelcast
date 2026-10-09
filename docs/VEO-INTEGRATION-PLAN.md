# Reelcast — Veo Integration

> Status: **implemented**. This document describes the Veo (AI video generation) feature as it exists in the code today: how a prompt becomes a video, where the state lives, how it fails, and which parts are still rough.
> Last updated: October 2026

---

## Executive Summary

Reelcast generates videos from text prompts with Google's Veo models, through the `@google/genai` SDK (`^2.6.0`, `ai.models.generateVideos()` plus operation polling). A generated video is stored in Cloudinary and from then on is an ordinary Reelcast video: it gets AI metadata, appears in the library, and goes through the same scheduling and publishing flow as an upload.

Key properties of the current design:

- **Platform-managed credentials.** Users do not bring Google credentials. The server uses either a Vertex AI service account (`GOOGLE_SERVICE_ACCOUNT_JSON` + `GOOGLE_CLOUD_PROJECT`) or a Gemini Developer API key. The key is read from the platform settings (Admin → Settings, stored encrypted) and falls back to the `GEMINI_API_KEY` environment variable. Google credentials are never per-user; the only per-user keys the server stores are Resend (email) and DeepSeek (assistant).
- **Plan-gated.** Each generation consumes one `veoGenerated` unit from the user's monthly allowance: Free 0, Pro 5 per month, Elite unlimited (see `PLAN_LIMITS` in `src/server/lib/usage.ts`).
- **Background job, not a request.** Generation takes minutes, so it runs as a `generation` job on the Postgres job queue. The handler is a resumable state machine that does one bounded step per run and defers itself between polls.
- **Defaults.** Model `veo-3.1-preview`, 720p, 16:9, 8 seconds, prompt enhancement on, audio requested (audio is only produced on Vertex AI, see Veo Client).

---

## Architecture Overview

```
/generate form
  │  rpc videos.createGenerated   plan pre-check, insert video (source_type 'generate', status 'draft', ai_config)
  │  rpc videos.updateStatus      draft -> queued
  │  rpc jobs.create              enqueue the 'generation' job; kickRunner() runs a tick right after the response
  ▼
job runner (runTick)  ->  generation handler (runGenerationJob)
  │  submit    consume 'veoGenerated' quota -> Veo generateVideos -> insert generations row,
  │            videos.status = 'generating' (one transaction) -> defer 15 s
  │  poll      getVideosOperation (one request per run) -> not done: defer 15 s
  │  finalize  stream Veo output -> Cloudinary -> videos.status = 'ready' -> metadata from the prompt -> notifications
  ▼
/video/[id]  polls videos.get every 4 s, shows progress while queued/generating, then the player and metadata
```

Where each piece lives:

| Concern | File |
|---|---|
| Google client, model ids, submit / poll / download | `src/server/lib/ai.ts` |
| State machine, quota, failure bookkeeping | `src/server/lib/generation/generationJob.ts` |
| Handler registration and `onJobFailed` hook | `src/server/jobs/handlers/generation.ts` |
| Streaming upload to Cloudinary, poster URL | `src/server/lib/generation/cloudinaryUpload.ts` |
| Shared error helpers (`safeMessage`, `isPlanLimitError`) | `src/server/lib/generation/common.ts` |
| Prompt-based metadata after a generation | `src/server/lib/generation/metadataRuns.ts`, `src/server/lib/ai/metadata.ts` |
| Entry points (create video, queue job, list generations) | `src/server/modules/videos.ts`, `jobs.ts`, `generations.ts` |
| Quota metering | `src/server/lib/usage.ts` |
| UI | `src/app/(app)/generate/page.tsx`, `src/components/generation/*`, `src/app/(app)/video/[id]/page.tsx` |
| Constants | `src/lib/constants.ts` |

---

## Data Model

Schema lives in `src/db/schema.ts` (Drizzle, Supabase Postgres). All tables are RLS-locked; only the server reads and writes them.

### `videos` (Veo-related columns)

| Column | Meaning |
|---|---|
| `source_type` | `'upload'` or `'generate'`. The `generation` job branches on this: `'generate'` runs the Veo state machine, `'upload'` runs Gemini metadata analysis. |
| `status` | `draft`, `queued`, `generating`, `ready`, `scheduled`, `publishing`, `published`, `failed`. |
| `ai_config` (jsonb) | Per-video generation settings, typed as `AiConfig` (below). |
| `veo_operation_name` / `veo_operation_done` | The long-running operation being tracked. Cleared when a run fails. |
| `raw_file_key` / `processed_file_key` | Empty string until the output exists. On success both are set to the Cloudinary URL of the generated file. |
| `thumbnail_url` | Poster frame derived from the Cloudinary URL when the generation completes. |

```ts
// src/db/schema.ts
export type AiConfig = {
  model?: string; prompt?: string; negativePrompt?: string;
  resolution?: string; aspectRatio?: string; durationSeconds?: number;
  generateAudio?: boolean; enhancePrompt?: boolean; numberOfVideos?: number;
  fps?: number; personGeneration?: string; seed?: number;
  preset?: string; quality?: string; captions?: boolean; backgroundMusic?: boolean; // upload-side presets
};
```

The server validates the shape with `generationConfigSchema` / `aiConfigSchema` in `src/server/lib/content/schemas.ts`. Note that `fps`, `personGeneration` and `seed` are accepted and stored but the generation job does not forward them to Veo (see Known Gaps).

### `generations` (one row per Veo submission)

`id`, `user_id`, `video_id`, `model`, `prompt`, `negative_prompt`, `resolution`, `aspect_ratio`, `duration_seconds`, `generate_audio`, `status`, `veo_operation_name`, `output_video_url`, `thumbnail_url`, `error`, `generation_time_ms`, timestamps.

- `status` is `submitted` -> `processing` -> `completed` or `failed` (CHECK constraint, `GENERATION_STATUSES`).
- A video can have several rows: a retry or a regeneration creates a new submission. The History page lists them (Generations tab, `generations.listByUser`).
- There is no token or cost column and no inline-output column; only the Cloudinary URL of the result is stored.

### `settings` (per-user defaults)

`veo_model`, `veo_resolution`, `veo_aspect_ratio`, `veo_duration_seconds`, `veo_enhance_prompt`, `veo_number_of_videos`, plus `veo_generate_audio` and `veo_person_generation`. The last two are accepted by `settings.update` but the job does not read them.

### Usage and job rows

- `usage_ledger.veo_generated` holds the month's count per user (`"YYYY-MM"`, UTC).
- The user-visible work item is a `jobs` row with `type = 'generation'`. A partial unique index allows only one pending/processing job per `(video, type)`, so a double click cannot start two generations. The job's `metadata` carries the resume state (`{ step: "poll", polls, operationName }`).

### Video status flow

| Transition | Written by |
|---|---|
| (new) -> `draft` | `videos.createGenerated` |
| `draft` / `failed` -> `queued` | `videos.updateStatus`, called by the Generate button and "Retry Generation" before the job is queued |
| `queued` -> `generating` | the job's submit step, in the same transaction that records the operation |
| `generating` -> `ready` | the job's finalize step, after the output is stored in Cloudinary |
| `queued` / `generating` -> `failed` | the job, on a permanent error or the last attempt (`markRunFailed`, `onGenerationJobFailed`) |
| `ready` -> `scheduled` -> `publishing` -> `published` | the normal publish flow, identical to uploaded videos |

`videos.updateStatus` only allows `queued` to be reached from `draft`, `queued` or `failed`, which is what makes "Retry Generation" on a failed video work. The `generating` and `failed` transitions are written only by the job.

---

## Veo Client

All Google AI client construction lives in `src/server/lib/ai.ts`.

**Client selection (`createAiClient`).** If both `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_CLOUD_PROJECT` are set, Vertex AI is used (`GOOGLE_CLOUD_LOCATION`, default `us-central1`). Otherwise the Gemini Developer API is used with the key passed in (the platform key) or `GEMINI_API_KEY`. If neither exists it throws `AiNotConfiguredError`, a permanent error.

**Model ids (`VEO_MODEL_IDS`).**

| Reelcast key | Google model id |
|---|---|
| `veo-3.1-preview` | `veo-3.1-generate-preview` |
| `veo-3` | `veo-3.0-generate-001` |
| `veo-3.1-fast-preview` | `veo-3.1-fast-generate-preview` |
| `veo-3-fast` | `veo-3.0-fast-generate-001` |
| `veo-3.1-lite` | `veo-3.1-lite-generate-preview` |
| `veo-2` | `veo-2.0-generate-001` |

An unknown key throws `VeoOperationError`. Adding a model means one entry here plus one in `VEO_MODELS` in `src/lib/constants.ts`.

**Submit (`submitVeoGeneration`).** Calls `ai.models.generateVideos({ model, source: { prompt }, config })` and returns only the operation name. Config sent: `numberOfVideos`, `resolution` (default 720p), `aspectRatio` (16:9), `durationSeconds` (8), `enhancePrompt` (true), `negativePrompt`, `seed`. `generateAudio` is added **only** on Vertex AI and only for `veo-3.1-preview`, `veo-3`, `veo-3.1-fast-preview` and `veo-3-fast`; on the Developer API audio is not requested.

**Poll (`pollVeoOperation`).** One request per call; the caller schedules the next one. The SDK needs a real `GenerateVideosOperation` instance (a plain object does not work), so the code builds a stub with the operation name. Results:

- not done: `{ done: false }`
- done with `operation.error`: throws `VeoOperationError` (permanent)
- done with no video (for example filtered by safety rules): throws `VeoOperationError` including the `raiMediaFilteredReasons` when present
- done with a video: returns `videoUri` (Developer API) or inline `videoBytes` (Vertex AI) plus the mime type. Only the first generated video is used even if `numberOfVideos` is greater than 1.

**Download (`openVeoDownload`).** Developer API output is a Gemini Files URI. It is only fetched from `https://generativelanguage.googleapis.com/` (anything else is rejected), with the API key in the `x-goog-api-key` header, and returned as a stream. Google deletes the file after about two days, so it is copied to Cloudinary immediately.

**Error classification.** `PermanentAiError` (and subclasses `AiNotConfiguredError`, `VeoOperationError`) mark failures a retry cannot fix. `isPermanentAiError` also treats any HTTP 4xx other than 408 and 429 as permanent. Everything else is retryable. Error text stored on rows or shown to users goes through `safeMessage`, which redacts API keys and bearer tokens.

---

## Generation Flow

### Enqueue

The `/generate` page calls `videos.createGenerated`, then `videos.updateStatus(queued)`, then `jobs.create({ type: "generation" })`, and navigates to `/video/[id]`.

- `createGenerated` checks `getUsage` and rejects with `PLAN_LIMIT_EXCEEDED:veoGenerated:<plan>` when the month's allowance is used up. Free users (limit 0) are therefore stopped here. This check does not consume anything.
- It inserts the video with `source_type = 'generate'`, `status = 'draft'`, an empty `raw_file_key`, `raw_file_size = 0`, the title set to the first 80 characters of the prompt, and the form values in `ai_config`.
- `jobs.create` calls `enqueueJob` (idempotent per video and type) and `kickRunner()`, which runs a tick right after the response so the submit step starts immediately.

### Submit step

The handler decides which step to run by looking for a `generations` row created since the job first started (`jobs.started_at`, which is stable across defers and reset only by a manual retry). No row means submit.

1. Resolve settings with the precedence **per-video `ai_config` > user `settings.veo_*` > fixed defaults** (`veo-3.1-preview`, 720p, 16:9, 8 s, enhance on, `numberOfVideos` 1, audio on). The prompt falls back to the video title.
2. `consumeQuota(db, userId, "veoGenerated")`: one atomic SQL statement increments the month's counter and enforces the limit, so concurrent callers cannot both slip under it. A plan-limit error becomes a non-retryable failure with the message "Video generation limit reached for your plan. Upgrade to generate more videos."
3. Look up the platform Gemini key (`getPlatformKey`) and call `submitVeoGeneration`. If the submit fails, the quota unit is refunded; a permanent error fails the job, a transient one is retried.
4. In one transaction, insert the `generations` row (`status = 'submitted'`, with the operation name) and set the video to `generating` with `veo_operation_name` / `veo_operation_done = false`. If this transaction fails the unit is refunded and the retry resubmits.
5. Return `{ deferMs: 15000, metadata: { step: "poll", polls: 0, operationName } }`.

### Poll step

If a `generations` row exists for this run, the handler polls the stored operation once:

- **Not done.** Increment `polls`. If `polls >= 40` **or** more than 10 minutes have passed since the generation row was created (`MAX_POLLS`, `MAX_GENERATION_MS`), fail permanently with "Generation timed out after Ns". Otherwise move the row from `submitted` to `processing` (first time only) and return `deferMs: 15000`.
- **Done.** Go to finalize.

`deferMs` is a minimum delay, not an exact one. `deferJob` puts the job back to `pending` with `run_at = now + 15 s` and does not consume a retry attempt. The job is picked up by the next runner tick: every minute in production (Supabase pg_cron calls `/api/cron/tick`) and every 5 seconds in development (`src/instrumentation.ts`). In production the real cadence is therefore roughly one poll per minute, which makes the 10-minute wall-clock cap the effective limit and the 40-poll cap a safety net.

### Finalize step

1. Build the Cloudinary public id `generated/<videoId>_<generationId>`.
2. If Veo returned a URI, open the download stream (needs the platform API key) and upload it with `uploadResponseToCloudinary`: one multipart request up to 16 MiB, or Cloudinary's chunked upload (8 MiB chunks, `X-Unique-Upload-Id` + `Content-Range`) for larger bodies with a known length. Nothing is base64-encoded. If Veo returned inline bytes (Vertex AI) it uses `uploadBytesToCloudinary`. The upload is signed with `overwrite=true`, so a re-run after a crash replaces the earlier copy instead of leaving an orphan.
3. Derive the poster URL (`cloudinaryPosterUrl`: a Cloudinary transform that takes the frame at 1 s, 640x360, and returns a JPEG).
4. In one transaction: set the video's `raw_file_key`, `processed_file_key`, `raw_file_size`, `thumbnail_url`, `veo_operation_done = true` and `status = 'ready'`; set the generation to `completed` with `output_video_url`, `thumbnail_url`, `generation_time_ms`.
5. Best effort from here on (a failure never fails the job): generate metadata from the prompt with Gemini (`gemini-2.5-flash`, skipped when the user has turned auto-generate off; it consumes one `metadataGenerated` unit and refunds it on failure; a plan limit just skips it), create the in-app notification "Video generated", and send the external notification through the metadata-ready toggle (`sendUserNotification(..., "metadataReady", { kind: "videoGenerated" })`).

The handler is idempotent. If the generation row is already `completed`, a later run does nothing; if it is `failed`, the run fails again without resubmitting.

### Failure bookkeeping and retries

- `runGenerationJob` wraps both paths. A **permanent** error (`NonRetryableError`, `PermanentAiError`, non-retryable 4xx), or **any** error on the last attempt, calls `markRunFailed`: the video becomes `failed`, `veo_operation_name` / `veo_operation_done` are cleared, the newest generation row of this run becomes `failed` with a redacted error message, and an in-app "Video generation failed" notification is created. The error is then rethrown.
- A **transient** error is rethrown without bookkeeping and the queue retries with exponential backoff (30 s, 60 s, ... capped at 15 minutes) up to `maxAttempts` (3 by default). Because the retry looks for the existing generation row, it resumes polling instead of paying for a second operation.
- `onGenerationJobFailed` is the `onJobFailed` hook registered for the `generation` type. It covers the case where a worker died on its last attempt and stale recovery gave up on the job: if the video is still `generating`, `queued` or `draft`, it runs the same `markRunFailed`. It is a no-op when the handler already recorded the failure.
- **Quota on failure.** The unit is refunded only when the submit call or the persisting transaction fails. A generation that was accepted by Google but later fails, is filtered, or times out keeps its unit.
- **Manual retry.** "Retry Generation" on a failed video sets the status to `queued` and creates a new job. The new job has a fresh `started_at`, so the handler submits a new operation and consumes a new unit.

---

## Frontend UI

### Generate page (`/generate`)

`src/app/(app)/generate/page.tsx` has two tabs.

**Generate Video** — four cards built from `src/components/generation/*`:

- `model-selector.tsx`: a card per model from `VEO_MODELS`, with a "Recommended" badge, a "max duration" badge and an Audio / No audio badge.
- `prompt-editor.tsx`: prompt textarea (2000 characters in the UI, at least 10 required to enable the button), a collapsible negative prompt, and five prompt presets (`PROMPT_PRESETS`).
- `config-panel.tsx`: resolution buttons (720p / 1080p), duration buttons (4 s / 6 s / 8 s), aspect ratio cards with proportional previews (16:9, 9:16, 1:1), an "Enhance Prompt" switch, and a "Generate Audio" switch shown when the selected model's `supportsAudio` is true.
- `generation-progress.tsx`: an animated status card (queued -> "Submitting to Veo...", generating -> "Generating your video..."). Its percentage is an estimate derived from props that the pages do not pass, so it shows a static value; it is a visual indicator, not real progress.

Initial values come from the user's `settings.veo_*` and `VEO_DEFAULTS`. On submit the page runs the three calls described under Enqueue and then navigates to the video detail page, so the in-page progress card is only visible for an instant.

**Generate Metadata** — a multi-select of the user's library that runs `actions.metadata.generateForUpload` sequentially per video and offers "mark selected as Ready". This belongs to the upload flow (see Dual-Flow Architecture) and has no Veo dependency.

### Video detail page (`/video/[id]`)

For `source_type = 'generate'` videos the page shows an "AI Generated" badge and a "Generation Config" card (prompt, model, resolution, aspect ratio, duration). While the status is `queued` or `generating` it shows the progress card and a "Veo is generating your video..." placeholder in place of the player. `draft` and `failed` videos show a **Generate Video** / **Retry Generation** button and a **New Generation** link. When the status becomes `ready` the player, the AI metadata card and the publish controls appear. The metadata card is display-only today (`MetadataEditor` has no save path, so titles and descriptions change only by regenerating them). Updates arrive by polling (`videos.get` every 4 s; the History generations list every 5 s; see `LIVE` in `src/lib/rpc/client.ts`); there is no push.

### Other surfaces

- Sidebar: "Generate" entry (`src/components/layout/sidebar.tsx`).
- Dashboard: a "Generate Video" button linking to `/generate`.
- History: a "Generations" tab listing every submission with prompt, model, status and generation time.
- Billing: the usage meters show Veo generations used against the plan allowance.

---

## Settings

**Per-user defaults** are edited in `/settings/ai` (`src/app/(app)/settings/ai/page.tsx`): default model (the same `ModelSelector`), resolution, aspect ratio, duration and prompt enhancement, next to the metadata defaults (auto-generate, per-field toggles, tone, language, description length, guidelines, humanize writing) and the brand-memory fields. They are saved through `settings.update` into `settings.veo_*`. The same Veo and auto-generate defaults can also be edited in the AI settings modal opened from `/settings` (`src/components/settings/ai-settings-modal.tsx`), and the metadata-only subset at `/ai-config`. The audio switch and person-generation setting are not part of any of these screens. `src/components/settings/ai-defaults-form.tsx` exists but is an empty file.

**Platform credentials** are an operator concern: an admin sets the Gemini API key in Admin → Settings (`admin.platformSettings.update`, encrypted at rest with `APP_ENCRYPTION_KEY`) and can test it there. Without a stored key the `GEMINI_API_KEY` environment variable is used. To use Vertex AI instead, set the three `GOOGLE_*` variables below; Vertex wins over the Developer API when both are present.

---

## Dual-Flow Architecture

Reelcast has two creation paths that meet at the video detail page.

**Path A — upload, then AI metadata, then publish**

```
Upload (signed direct-to-Cloudinary) -> videos.create (source_type 'upload')
  -> auto-generate metadata unless the user turned it off (actions.metadata.generateForUpload)
  -> review -> mark ready -> schedule / auto-publish / publish now
```

**Path B — prompt, then Veo, then AI metadata, then publish**

```
/generate -> createGenerated -> 'generation' job -> Veo -> Cloudinary -> status 'ready'
  -> metadata generated from the prompt -> review -> schedule / auto-publish / publish now
```

The same `generation` job type serves both paths: for an upload it analyses frames with Gemini and sets the metadata; for a generated video it runs the Veo state machine. Routes: `/generate` (new), `/upload` (existing), `/video/[id]` (shared), `/drafts` (library, shows both kinds).

---

## Constants and Configuration

`src/lib/constants.ts` is the source for the UI (the server keeps its own id map in `src/server/lib/ai.ts`).

| Constant | Current value |
|---|---|
| `VEO_MODELS` | Six models, all with `maxDuration` 8 and the same resolutions and aspect ratios. **Veo 3.1 Preview** (recommended, audio), **Veo 3** (audio), **Veo 3.1 Fast Preview** (audio), **Veo 3 Fast** (audio), **Veo 3.1 Lite Preview** (no audio), **Veo 2** (no audio) |
| `VEO_RESOLUTIONS` | `720p` (default), `1080p` |
| `VEO_ASPECT_RATIOS` | `16:9` (default), `9:16`, `1:1` |
| `VEO_DURATIONS` | 4 s, 6 s, 8 s (a code comment notes that Vertex AI supports only these for text-to-video) |
| `PROMPT_PRESETS` | Cinematic Landscape, Product Showcase, Tutorial Intro, Social Media Clip, Abstract Motion |
| `VEO_DEFAULTS` | model `veo-3.1-preview`, 720p, 16:9, 8 s, enhance prompt on, audio on, `numberOfVideos` 1 |

Types: `AiConfig` in `src/db/schema.ts` (server and DB), `src/types/generation.ts` (`GenerationConfig`, `GenerationDefaults`, `GenerationRecord` for the UI). The `NAV_ITEMS` list in this constants file is not used; the sidebar defines its own.

Timing and limit constants for the job: `POLL_DEFER_MS` 15,000, `MAX_POLLS` 40, `MAX_GENERATION_MS` 10 minutes (`src/server/lib/generation/generationJob.ts`); Cloudinary single-upload ceiling 16 MiB and chunk size 8 MiB (`cloudinaryUpload.ts`).

---

## Environment Variables

From `.env.example`:

```env
# Gemini AI (an admin can also set the key in Admin → Settings)
GEMINI_API_KEY=your_gemini_api_key
# Optional: Vertex AI for Veo (service-account JSON, single line)
# GOOGLE_SERVICE_ACCOUNT_JSON=
# GOOGLE_CLOUD_PROJECT=
# GOOGLE_CLOUD_LOCATION=us-central1
```

Also required by the flow: the Cloudinary variables (`NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`), `APP_ENCRYPTION_KEY` (decrypts the stored platform key), and `CRON_SECRET` plus the pg_cron job that drives the runner in production.

---

## UX

- **Model cards** are radio-style cards (not a dropdown) with a Recommended badge, capability badges and a short description; selecting a card updates the audio switch.
- **Aspect ratio** is a row of cards with proportional mini-rectangles; the selected one gets a primary border.
- **Duration and resolution** are segmented buttons.
- **Prompt editor** has a live character counter that turns red near the limit, collapsible presets and negative prompt, and a disabled submit button below 10 characters.
- **Generation states** use a spinner with a ping halo and a three-dot pulse while `queued` / `generating`; `globals.css` also defines the `veo-pulse` and `shimmer` keyframes (`.animate-veo-pulse`, `.shimmer-loading`).
- **After submit** the user lands on the video page, where the status card and placeholder explain that generation typically takes a few minutes, and the page updates itself by polling.

---

## Scalability and Error Handling

**Concurrency and rate limiting.**

- At most one active `generation` job per video (partial unique index). There is no per-user concurrency cap or global Veo rate limiter; the effective brakes are the plan allowance and the runner's per-tick concurrency (default 3).
- The runner is at-least-once: a worker that dies mid-step is recovered after the stale window (10 minutes) and the handler resumes from persisted state.

**Errors.**

| Situation | Behaviour |
|---|---|
| No Google credentials | `AiNotConfiguredError` (permanent); video `failed` with a clear message |
| Plan allowance used up | Rejected up front by `createGenerated`; on the job path a non-retryable failure |
| Veo rejects the request (4xx) or reports an operation error | Permanent; video `failed`, error stored on the generation row |
| Safety filter / no video returned | `VeoOperationError` with the filter reasons when Google gives them |
| Network or 5xx / 408 / 429 | Retried with backoff (30 s, 60 s, ...) up to 3 attempts; polling resumes, no double submit |
| Generation exceeds 10 minutes or 40 polls | Permanent "timed out"; the quota unit is kept |
| Output cannot be copied to Cloudinary | Retried; permanent only when there is no key to download or no data |
| Worker crash on the last attempt | `onGenerationJobFailed` marks the video failed |

**Cost management.** Each submission is one metered unit per month; the number of generations and their duration are recorded in `generations` (including `generation_time_ms`). There is no per-generation cost estimate and no dedicated usage dashboard for Veo beyond the Billing page meters and Admin → Usage.

**Future models.** A new Veo model needs an entry in `VEO_MODEL_IDS` (server) and `VEO_MODELS` (UI); the pages render from the constant. If a model supports audio on Vertex AI it must also be added to `AUDIO_CAPABLE_MODELS` in `ai.ts`.

---

## Known Gaps

These are real differences between what the UI or schema suggests and what the code does, collected as of October 2026.

- **Audio.** `generateAudio` is only sent on Vertex AI for the four audio-capable models, but the Generate Audio switch appears for any model whose `supportsAudio` constant is true, including when only a Developer API key is configured. `generations.generate_audio` records the requested value, not whether audio was actually produced. `settings.veo_generate_audio` is stored but not read by the job.
- **Unused parameters.** `personGeneration`, `seed` and `fps` exist in `AiConfig` and the zod schema but are not passed to Veo; `settings.veo_person_generation` is stored but unused. If `numberOfVideos` is greater than 1, only the first video is kept.
- **Default model mismatch.** `/settings/ai` and the settings modal fall back to `veo-2` for a user with no saved default, while the generate page and the job fall back to `veo-3.1-preview`. Saving either settings screen without touching the model therefore stores `veo-2`.
- **Detail page model label.** The Generation Config card labels every model other than `veo-3.1-fast` as "Veo 3 Fast", so current model keys are shown wrongly.
- **Generate page feedback.** A failed submit (including a plan-limit error for free users) is only logged to the console; the form reappears with no message. There is no cancel button, and no `video-preview.tsx` component exists (the detail page player is used instead).
- **Progress display.** The progress card does not receive real attempt data, so its percentage and "Attempt 1 of 40" text are not meaningful.
- **Poll cadence.** The 15 s `deferMs` is a lower bound; production polls arrive about once a minute because the runner ticks once a minute.
- **Metadata editing.** `src/components/metadata-editor.tsx` renders the AI title, description and tags but does not save edits; there is no mutation for manual metadata changes.
- **Empty file.** `src/components/settings/ai-defaults-form.tsx` is empty.
- **Unverified against Google's current API.** The preview model ids, 1080p with durations other than 8 s, and the 1:1 aspect ratio are offered by the UI; whether each model accepts every combination has not been verified here.
