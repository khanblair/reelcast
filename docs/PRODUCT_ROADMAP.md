# Reelcast — Product Roadmap & Feature Specification

> Internal working document. Covers current state, planned features, architecture evolution, and long-term vision.
> Last updated: August 2026

---

## 1. Vision & Mission

**Mission:** Give every YouTube creator, team, and agency the infrastructure to publish consistently, intelligently, and at scale — without the operational overhead.

**Vision:** Reelcast becomes the operating system for YouTube content operations. Not just a scheduler — a full publishing workflow platform that combines AI, automation, collaboration, and analytics into one system creators actually live inside.

**Core insight:** The bottleneck for most YouTube channels is not ideas or even production — it is the repetitive operational work between "video exists" and "video is live and performing." Reelcast eliminates that gap.

---

## 2. Current State (What Is Built)

This section captures what exists and works in production today. Every feature below is implemented in code.

### 2.1 Video Management
- Multi-file drag-and-drop upload to Cloudinary with real-time per-file progress
- Video library (`/drafts`) with search, status filter pills, sort options
- Individual video detail page with inline HTML5 player (9:16 aspect ratio)
- Publish-as toggle (Short vs. long-form video) — strips `#Shorts` from description for long-form
- Privacy selector (private / public / unlisted) per video
- Bulk operations: mark all drafts ready, switch long videos (>60s) to "video" type
- Post-publish Cloudinary cleanup (storage freed automatically after YouTube confirms upload)
- Video delete with Cloudinary asset destruction

### 2.2 Publishing Pipeline
- **Manual publish now** from video detail page
- **Single-video scheduling** — pick a datetime, Convex scheduler fires the job at that exact time
- **Auto-publish batch system** — configurable timezone, posting times (up to 24 time slots), videos-per-slot, privacy; self-scheduling chain with atomic video claiming to prevent double-publish
- YouTube token auto-refresh when within 5 minutes of expiry
- Publish retry with exponential backoff (3 attempts: immediate, +60s, +120s)
- YouTube resumable upload (handles large files)
- Job history page with retry button for failed jobs

### 2.3 AI Metadata Generation
- Gemini 2.5 Flash frame analysis: extracts 3 frames (0%, 25%, 75%) from Cloudinary via URL transforms, sends as images to Gemini with a VidIQ-style SEO prompt
- Outputs: title (≤55 chars, curiosity-gap), description (4-line: snippet + gain + CTA + hashtags), 12–15 tiered tags
- Personalised by user's tone and custom channel guidelines stored in settings
- Scheduled metadata generation: queue draft videos to get AI metadata at a future time (e.g., overnight batch)
- Regenerate metadata on demand from the video detail page
- Auto-mark-ready flag: metadata jobs can auto-transition videos to "ready" on completion

### 2.4 AI Video Generation (Veo) — BYOK
- Supports Veo 2, Veo 3, Veo 3 Fast, Veo 3.1 Preview, Veo 3.1 Fast, Veo 3.1 Lite
- Config: prompt, negative prompt, resolution, aspect ratio, duration, enhance prompt, generate audio (Vertex AI only)
- Long-running operation polling (15s interval, up to 10 minutes)
- Output video downloaded from Google Files API, uploaded to Cloudinary, AI metadata auto-generated from original prompt
- **BYOK model:** User supplies their own credentials — either a Gemini Developer API key or a Vertex AI service account JSON. Stored encrypted in Convex settings. Reelcast holds no shared quota; all generation costs and rate limits fall on the user's own Google account.

### 2.5 Notifications
- **Discord:** webhook URL per user, posts on publish success and publish failure
- **Telegram:** bot token + chat ID per user, posts on metadata ready, publish success, publish failure
- In-app notification bell (stores last 50 in Convex, mark read / mark all read / clear all)
- Enable/disable toggle per user; auto-enables when a channel is first connected
- Test send button for both channels

### 2.6 Analytics (Current — DB-Only)
- Status distribution (draft / ready / published / failed counts)
- Upload timeline (period-filtered: today hourly, week daily, month weekly, all-time monthly)
- Total video count (all-time), total storage bytes, total duration seconds
- Dashboard live countdown to next auto-publish
- Estimated publish time per video based on queue position and auto-publish schedule

### 2.7 Settings & Configuration
- YouTube OAuth connect/disconnect (stores access + refresh token in Convex)
- AI defaults: auto-generate toggle, per-field toggles (title/description/tags), tone, language, description length, custom guidelines (1000 chars)
- Veo defaults: model, resolution, aspect ratio, duration, audio, enhance prompt
- Auto-publish defaults: timezone, interval, count, privacy, time slots
- **BYOK keys stored in settings (encrypted):**
  - `geminiApiKey` or `vertexServiceAccountJson` — for Veo video generation
  - `resendApiKey` + optional `emailFromAddress` — for email notifications

### 2.8 Infrastructure
- Supabase Google OAuth → custom RS256 JWT bridge → Convex auth
- Convex HTTP actions serve OIDC discovery + JWKS (publicly reachable)
- 1-minute cron scans for due scheduled publishes
- bfcache prevention (Cache-Control: no-store on protected routes + pageshow reload)

---

## 3. Immediate Completions (v1.1) — Close the Gaps

These are features that are partially built or blocked by a small gap. High value, low effort.

### 3.1 Auto-Generate on Upload
**Gap:** `settings.aiAutoGenerate` flag is stored but never read by the upload flow.
**Fix:** After `api.videos.create` succeeds in the upload page, check `userSettings.aiAutoGenerate`. If true, immediately dispatch `api.actions.metadata.generateForUpload` for the new video ID.
**Impact:** Users who enable auto-generate in AI settings will get metadata immediately after upload without a manual trigger. This closes the primary friction point in the upload → publish workflow.

### 3.2 Schedule Button on Video Detail Page
**Gap:** The "Schedule" button on `/video/[id]` renders with no `onClick`. Clicking it does nothing.
**Fix:** Wire the button to open an inline date-time picker popover that calls `api.videos.schedulePublish`. No need to navigate to `/schedule` for single-video scheduling.

### 3.3 Thumbnail System
**Gap:** `thumbnailUrl` field exists on `videos` and `generations` tables but is never populated.
**Fix (uploaded videos):** On upload, generate a thumbnail using a Cloudinary URL transform (`/so_0/w_400/q_auto/f_jpg/`) and store it. On video detail and VideoCard, display the thumbnail instead of the placeholder icon.
**Fix (Veo-generated videos):** `pollVeo` should save the thumbnail URL returned by the Veo API into the `generations.thumbnailUrl` field and copy it to `videos.thumbnailUrl`.
**Impact:** VideoCards and video detail pages become visually meaningful instead of showing a generic placeholder.

### 3.4 Generations History Page
**Gap:** `api.generations.listByUser` query exists but no page consumes it.
**Fix:** Add a "Generations" tab or section to the History page showing the Veo generation log per video: prompt, model, status, generation time (ms), and a link to the video.

### 3.5 Complete Settings Sub-Pages
**Gap:** Five routes (`/settings/youtube`, `/settings/telegram`, `/settings/notifications`, `/settings/general`, `/settings/ai`) all return "Coming soon."
**Fix:** Move the relevant section from the main `/settings` page into each sub-page. The main `/settings` page becomes a nav hub with cards linking to each section. This also makes the URL structure navigable and deep-linkable (e.g., redirect `?youtube=connected` directly to `/settings/youtube`).

### 3.6 Email Notifications (BYOK — Resend)
**Gap:** No email notification path exists at all.
**Model:** Bring Your Own Key. The user creates a free Resend account, generates an API key, and pastes it into Reelcast settings. Reelcast stores it encrypted in Convex and uses it to send emails on the user's behalf. Reelcast never holds a shared Resend account — each user's emails are sent from their own Resend key and, optionally, their own verified sending domain.
**Fix:** Add a `resendApiKey` field (and optional `emailFromAddress`) to the `settings` table. On publish success and failure, read the user's stored key and call the Resend API from a Convex action.
**Templates needed:** Publish success (with YouTube link + thumbnail), publish failure (with error message + retry CTA), weekly digest (optional).
**Fallback:** If no Resend key is configured, email notifications are silently skipped — no error shown, just not sent. A settings banner prompts: "Add a Resend API key to enable email notifications."

### 3.7 Backfill `aiAutoGenerate` Settings Default
**Gap:** The flag defaults to `undefined` in the DB (not `false`). Code checking `if (settings.aiAutoGenerate)` will behave correctly, but the UI toggle shows an indeterminate state for users who have never touched this setting.
**Fix:** Normalise to explicit `false` on first settings upsert. Already correct for new users; existing users need a one-time migration.

---

## 4. Core Platform Enhancements (v1.2)

### 4.1 YouTube Analytics Integration
**Current state:** All analytics are computed from local Convex data. No YouTube data (views, watch time, CTR, subscribers) is pulled.

**What to build:**
- Connect to YouTube Analytics API (`youtubeanalytics.googleapis.com/v2/reports`) using the stored YouTube OAuth access token
- Per-video metrics: views, watch time (minutes), average view duration, impressions, CTR, likes, comments
- Channel-level metrics: subscriber change over period, total views, revenue (if monetised)
- Cache responses in Convex (TTL: 1 hour) to avoid hitting YouTube quota limits
- Dashboard "Performance" section: top-performing videos by views and CTR, subscriber growth chart
- Video detail page: show live YouTube metrics below the player for published videos

**Data model additions:**
```
videoAnalytics table:
  videoId, youtubeVideoId, fetchedAt
  views, watchTimeMinutes, avgViewDurationSec
  impressions, ctr, likes, comments, subscribersGained
```

### 4.2 OAuth Health Dashboard
**Current state:** If the YouTube access token expires and the refresh also fails (e.g., user revokes access in Google), publish jobs fail silently with a generic error.

**What to build:**
- A dedicated status indicator in the topbar or settings showing YouTube connection health
- Background check action: call `youtube/v3/channels?mine=true` with the stored token every 6 hours, flag if it returns 401
- `youtubeOAuthStatus` field on user record: `connected | token_expired | revoked | unknown`
- Alert banner on dashboard and video detail when OAuth is unhealthy
- One-click "Re-authorise" button that initiates the OAuth flow without disconnecting existing tokens

### 4.3 Bulk Metadata Operations
**Current state:** Bulk metadata generation exists in the Generate page (select multiple videos, run sequentially). No way to bulk-assign the same metadata settings or bulk-schedule.

**What to build:**
- In the video library (`/drafts`): checkbox multi-select mode
- Bulk actions toolbar: "Generate Metadata", "Mark Ready", "Schedule Metadata For", "Delete"
- Bulk schedule: pick a start datetime and gap interval; assign each selected video a `metadataScheduledAt` in sequence
- Bulk delete with Cloudinary cleanup (dispatch `deleteVideo` action per video)

### 4.4 Content Calendar
**Current state:** Scheduling exists only as a list + datetime picker. No visual calendar.

**What to build:**

**Minimal inline view on `/schedule` page:**
- A compact week-strip (7-day horizontal bar) above the existing schedule list
- Each day shows a dot or count badge for scheduled/auto-publish slots
- A "View Full Calendar →" button links to `/content-calendar`

**Full view at `/content-calendar`:**
- Toggle between week and month views
- Drag-and-drop videos from a ready-pool sidebar onto calendar time slots
- Dropping a video on a slot calls `api.videos.schedulePublish` for that datetime
- Visual indicators: auto-publish slots (blue), manually scheduled (green), past publishes (grey)
- Click any scheduled slot to preview video thumbnail, title, and scheduled time
- Remove scheduling directly from the calendar (reverts video to ready status)

### 4.5 Publish Queue
**Current state:** The dashboard shows a countdown and ready count but doesn't show the actual ordered queue with estimated times.

**What to build:**
- A dedicated `/queue` page showing every ready video in publish order
- Each row: video thumbnail, title, estimated publish datetime (computed from auto-publish schedule + position), status
- **Publish Now button** per row — lets a user jump a specific video to the front and publish it immediately, bypassing the auto-publish schedule; fires `api.actions.publish.publishNow(videoId)`
- Drag-to-reorder: dragging changes the implicit queue order (stored as an explicit `publishOrder` field or derived from creation time)
- If auto-publish is off: shows the backlog with a CTA to enable auto-publish

### 4.6 Advanced Notification Rules
**Current state:** Notifications fire on publish success and failure only. Both channels (Discord/Telegram) get the same message.

**What to build:**
- Per-event notification toggles: publish success, publish failure, metadata ready, weekly digest, storage warning
- Custom message templates per event (e.g., include YouTube link, channel name, video thumbnail URL)
- Discord rich embeds: instead of `{ content: message }`, send a proper Discord embed with thumbnail, title as embed title, YouTube URL as button, color-coded by success/failure
- Telegram inline keyboard: message with "View on YouTube" button
- Notification digest: weekly summary email/Discord message with publish stats

### 4.7 Storage Management Page
**Current state:** Storage bytes shown on dashboard as a single number. No detail on which videos consume storage or a way to free storage manually.

**What to build:**
- `/settings/storage` page listing all videos with their `rawFileSize`
- Sort by size descending
- For published videos (where Cloudinary was supposed to be cleaned up): show "Cleaned" badge or "Cleanup Failed" with a retry button
- Manual cleanup button for any published video whose Cloudinary files weren't deleted

### 4.8 AI Assistant
An embedded AI that understands the user's content library, publishing schedule, and DB-level analytics. Accepts natural language commands. Ships in v1.

**AI Provider: DeepSeek**
DeepSeek does not process video frames or images. All context is constructed from structured database data: video records (title, description, tags, status, timestamps), job history (publish times, success/failure), analytics rows (views, CTR, watch time from YouTube), and user settings. The AI assistant synthesises these into answers and takes actions without ever needing to see the video file itself.

**Capabilities:**

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

*Analytics & intelligence (from DB):*
- "Which of my published videos got the most views this week?"
- "What content format is performing best — Shorts or long-form?"
- "How many videos did I publish last month?"
- "Show me videos with high impressions but low CTR"

*Content discovery:*
- "What are the trending topics in [niche] right now?"
- "Suggest 5 video ideas based on my top performers"
- "What gaps exist in my content calendar?"

**Implementation architecture:**

*Input:* Natural language text via a chat interface (slide-out panel from the topbar).

*Processing pipeline:*
1. User message → DeepSeek with a system prompt that includes a structured context snapshot: video library summary (counts by status, recent titles/tags), publishing schedule, job failure rate, and cached YouTube analytics
2. DeepSeek selects which Convex function(s) to call using its function-calling / tool-use capability
3. Convex functions execute and return structured data
4. DeepSeek formats the final response with the data and any action confirmations

*Tool schema:*
```
listVideos(status?, limit?, createdAfter?) → VideoSummary[]
updateVideoMetadata(videoId, title?, description?, tags?) → void
scheduleVideo(videoId, publishAt, privacy?) → void
bulkScheduleVideos(videoIds, startAt, intervalMs) → void
getAnalytics(period, metric) → AnalyticsData
generateMetadata(videoId) → AIMetadata
searchVideos(query) → VideoSummary[]
getPublishQueue() → QueueItem[]
saveIdea(title, notes) → void
```

*UI:* Floating chat panel (slide-in from a topbar button), persistent message history per user, supports follow-up questions, shows "thinking" indicator while DeepSeek calls tools.

**Brand Memory:**
- User defines channel identity: niche, target audience, brand voice, forbidden words, CTA preferences
- Stored in `settings.aiGuidelines` (currently 1000-char free-text — extend to structured fields)
- Injected into every DeepSeek system prompt so all responses stay on-brand

### 4.9 Content Intelligence
Surfaces actionable insights about what's performing and what to create next. Ships in v1.

**Trending Topics:**
- Data sources: YouTube Data API trending in channel category, YouTube search by keyword sorted by viewCount (last 7 days)
- `/intelligence` page: trending topics dashboard for the user's niche
- Keyword cards: search volume trend (7d), top video examples, estimated competition level
- "Create video on this topic" CTA → pre-fills the Veo prompt or creates a draft with suggested metadata

**Opportunity Score:**
- Per-topic score (1–100): search volume trend × (1 / competition) × alignment with user's content history (derived from published video tags)
- Shown as a colour-coded badge on each trending topic card
- Updated daily via a scheduled Convex action

**Content Gap Analysis:**
- Compare the user's published video tags/topics against trending topics in their niche
- Highlight topics that are trending but the user has zero coverage on
- "Your competitors are on this — you aren't" insight panel, powered by YouTube search on competitor channel IDs (user inputs competitor channel URLs in settings)

**Idea Vault:**
- Users save topic ideas, prompts, and video concepts to a personal vault
- `/ideas` page: list of ideas with status (concept / in production / published)
- Convert any idea to a Veo generation or a draft with one click
- AI Assistant can add to the vault: "Save this to my idea vault"
- Ideas support a "planned generate date"

**Performance Prediction:**
- DeepSeek predicts expected CTR and view velocity from title + tag combination, using the user's own past publish data as examples in the prompt (no image analysis needed)
- Shown as a "predicted performance" indicator on the metadata editor before publishing
- A/B title testing: generate 3 title variants, user picks one, system tracks which performed best

### 4.10 Advanced Analytics
Builds on the v1.2 YouTube Analytics foundation with deeper per-video and channel-level insight. Ships in v1.

**Deeper YouTube Analytics:**
- Revenue tracking (monetised channels): estimated revenue per video, RPM, CPM
- Audience retention curves: per-video watch time graph (where viewers drop off), fetched from YouTube Analytics API and rendered as a line chart on the video detail page
- Traffic source breakdown: YouTube search vs. suggested vs. external per video
- Subscriber attribution: which videos gained the most subscribers

**Publishing Performance Dashboard:**
- Best posting times for this channel (derived from past publish performance — views in first 48h vs. time of day)
- Format performance: Shorts vs. long-form view velocity comparison
- Metadata quality score: correlation between AI-generated metadata quality indicators and CTR
- Content series tracking: group related videos by tag, compare series performance

**Automated Reports:**
- Weekly email digest: publish count, total views this week, top video, subscriber change
- Digest sent via Resend to the user's email on Sunday morning (scheduled Convex action)

### 4.11 Admin Dashboard
**Current state:** No admin view exists. There is no way to see system-level health, user activity, or operational metrics.

**What to build:**
- `/admin` route, accessible only to users with an `isAdmin: true` flag on their user record
- **System health panel:**
  - Total registered users, total videos in DB, total jobs run today
  - Active auto-publish configurations (count of users with auto-publish on)
  - Publish success rate (last 24h and last 7d): successful / total attempts
  - Failed jobs in the last 24h with links to their job records
- **User table:**
  - List of all users: email, signup date, last active, video count, published count, YouTube connection status
  - Filter by: has YouTube connected, has auto-publish enabled, joined in last 30 days
  - Click a user to see their video list and job history
- **YouTube API quota tracker:**
  - API units consumed today vs. daily limit (10,000 units)
  - Alert badge when above 80%
- **Storage overview:**
  - Total Cloudinary storage used across all users
  - Top 10 users by storage consumption
- **Notification health:**
  - Discord webhook success/failure rate (last 24h)
  - Telegram send success/failure rate (last 24h)

---

## 5. Multi-Channel Support (v1.3)

**Current state:** One YouTube channel per user account. `youtubeAccessToken`, `youtubeChannelName`, etc. are single fields on the `users` table.

### 5.1 Data Model
```
youtubeChannels table:
  userId, channelId (YouTube channel ID)
  channelName, channelThumbnail
  accessToken, refreshToken, tokenExpiry
  isDefault (boolean)
  connectedAt

videos table additions:
  targetChannelId (ref youtubeChannels, optional — defaults to user's default channel)
```

### 5.2 Channel Management UI
- `/settings/youtube` page: list of connected channels with connect/disconnect per channel
- "Set as default" toggle per channel
- Per-channel OAuth flow: existing `/api/youtube/connect` route accepts `?channelHint=` to guide users to the right Google account

### 5.3 Per-Video Channel Selection
- Video detail page: channel selector dropdown when multiple channels are connected
- Auto-publish settings: select which channel the batch publishes to

### 5.4 Multi-Channel Publishing (Same Video)
> **Important:** Publishing the same video file to the same YouTube channel more than once violates YouTube's duplicate content policies and will result in the second upload being flagged or removed, and repeated violations can lead to account suspension.

**What Reelcast supports:**
- Publishing a video to **different channels** (e.g., an English channel and a Spanish channel) — each channel has its own upload, so these are distinct uploads on distinct accounts and are not flagged
- Publishing a **different version** of a video (different file, different edit) to the same channel

**What Reelcast will not do silently:**
- If a user attempts to publish a video to a channel it has already been published to, the UI shows a warning: "This video has already been published to [channel name]. Re-uploading the same file to the same channel may violate YouTube's duplicate content policy. Are you sure?"
- The warning is hard-gate: the user must explicitly confirm before the second publish job is created

---

## 6. Organizations & Teams (v2.0)

This is the largest architectural addition. It transforms Reelcast from a single-user tool into a collaboration platform for creator teams.

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
```
organizations table:
  name, slug, logoUrl, plan (free | pro)
  ownerId (ref users), createdAt, billingCustomerId

workspaces table:
  orgId (ref organizations), name, slug
  description, youtubeChannelIds (array)

orgMembers table:
  orgId, userId, role, invitedBy, joinedAt, status (active | invited | suspended)
  index: by_org, by_user

workspaceMembers table:
  workspaceId, userId, role (inherits org role or overrides)
  index: by_workspace, by_user

invitations table:
  orgId, email, role, token, expiresAt, invitedBy, status (pending | accepted | expired)
```

All existing tables (`videos`, `jobs`, `settings`, `notifications`) gain an `orgId` and `workspaceId` field.

### 6.4 Approval Workflow

**Flow:**
1. Editor uploads a video and adds metadata → status: `awaiting_review`
2. Reviewer(s) receive in-app notification and email: "New video ready for review"
3. Reviewer opens video detail page, sees the full metadata, can play the video
4. Reviewer actions: **Approve** (transitions to `ready`), **Request Changes** (returns to `draft` with a comment), **Reject** (marks as `rejected`)
5. On approval, the video enters the publish queue per normal flow
6. Editor receives notification of the decision with the reviewer's comment

**Data model:**
```
videoReviews table:
  videoId, reviewerId, decision (approved | changes_requested | rejected)
  comment, createdAt

videos table additions:
  reviewStatus (none | awaiting | approved | rejected)
  reviewRequestedAt, reviewCompletedAt
  requiresReview (boolean, set per workspace)
```

### 6.5 Activity Feed
- Per-workspace timeline of all actions: upload, metadata generated, approved, published, failed, member joined, etc.
- Filter by member, by video, by action type
- Used for team accountability

---

## 7. Monetisation & Pricing

Two tiers only: Free and Pro. No team, agency, or enterprise plans at this stage.

### Tier Design

**Free**
- 1 user, 1 YouTube channel
- 10 videos/month upload
- 5 AI metadata generations/month
- Discord notifications only
- 1GB storage
- Manual publish only (no auto-publish)
- No AI Assistant
- No Content Intelligence

**Pro — $19/month**
- 1 user, up to 3 YouTube channels
- Unlimited uploads
- Unlimited AI metadata generations
- 5 Veo video generations/month
- Auto-publish (unlimited slots)
- Discord + Telegram + Email notifications
- 25GB storage
- YouTube Analytics integration
- AI Assistant (full)
- Content Intelligence (full)
- Advanced Analytics
- Content Calendar
- Publish Queue with Publish Now

### Billing Implementation
- Payment processor: **TBD** (Stripe is the leading candidate but not finalised)
- Plan limits enforced in Convex mutations: check usage counts before allowing gated actions
- `users.plan` field (currently implicit Free for all users) drives limit checks
- Billing events update `users.plan` via a webhook → Convex HTTP action
- Usage metering for Veo generations tracked in a `usageLedger` table (month-scoped counters)

---

## 8. Technical Architecture Evolution

### 8.1 Queue System
**Current:** Convex scheduled functions (one per job). Works well up to ~1000 concurrent scheduled functions.
**At scale:** If publish volume exceeds Convex scheduler limits, introduce a proper queue:
- `publishQueue` table with polling worker (Convex action on 30-second cron)
- Concurrency limit: max 10 active publish jobs at once
- Priority queue: manual "Publish Now" jobs jump ahead of auto-publish batch

### 8.2 Storage Evolution
**Current:** Cloudinary for all video storage. Files deleted from Cloudinary after YouTube publish.
**Issue:** Veo-generated videos are temporarily stored in Cloudinary but large (100MB–500MB each); Cloudinary bandwidth costs scale with video count.
**Future:** Move to Cloudflare R2 for raw storage (zero egress fees), keep Cloudinary only for thumbnail generation and frame extraction transforms.

### 8.3 Multi-Tenancy Isolation
All Convex queries and mutations must be updated to filter by `orgId` and `workspaceId` in addition to `userId`. The pattern:
```ts
// Current (single-user)
ctx.db.query("videos").withIndex("by_user", q => q.eq("userId", user._id))

// Multi-tenant
ctx.db.query("videos")
  .withIndex("by_workspace", q => q.eq("workspaceId", args.workspaceId))
  .filter(q => q.eq(q.field("orgId"), args.orgId))
```
Convex indexes must be added: `by_org`, `by_workspace`, `by_org_status`.

### 8.4 YouTube Quota Management
YouTube Data API has a daily quota of 10,000 units. A resumable upload costs 1,600 units. At 6 uploads/day per user, the quota holds comfortably for single users but tightens with multi-channel + analytics polling:
- Track API units consumed per day in a `youtubeQuotaUsage` table
- Show quota usage in the Admin Dashboard
- Graceful degradation: warn users before allowing publishes if quota is low

### 8.5 Monitoring & Observability
**Current:** No monitoring beyond Convex's built-in function logs.
**What to add:**
- Sentry for Next.js error tracking (client + server)
- Convex function error alerting: if `processPublishJob` failure rate exceeds 5% in a 1-hour window, send a Discord alert to the Reelcast internal Discord
- Uptime monitoring for the `/api/auth/token` and `/api/youtube/callback` routes
- YouTube API quota tracking with alert at 80% usage
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

**Sequence:**
1. **Thumbnail system** — Visual polish; biggest perceived quality uplift
2. **Auto-generate on upload** — Removes the #1 friction point in the daily workflow
3. **Schedule button on video detail** — Removes navigation friction for single-video scheduling
4. **Email notifications** — Required for users without Discord/Telegram
5. **Content Calendar** — Minimal strip on `/schedule` + full `/content-calendar` page; first "wow" moment
6. **Publish Queue with Publish Now** — `/queue` page; gives users granular control
7. **OAuth health dashboard** — Prevents silent publish failures from destroying trust
8. **YouTube Analytics integration** — Key retention driver; users stay active once they see performance data
9. **Admin Dashboard** — Internal operational visibility; required before scaling user base
10. **AI Assistant (DeepSeek)** — Differentiation from all competitors; drives Pro upgrades
11. **Content Intelligence** — Trending topics + Idea Vault; makes Reelcast part of the creative process
12. **Advanced Analytics** — Retention curves, traffic sources, best posting times
13. **Billing (Free + Pro)** — Monetisation infrastructure; unlock after AI features are stable
14. **Multi-channel support** — Expands Pro value; builds on billing foundation
15. **Organizations & Teams** — v2.0; opens the collaborative creator market
