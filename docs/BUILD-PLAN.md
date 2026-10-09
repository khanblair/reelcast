# ReelCast — Phased Build Plan

## Structural Issues to Fix First

The scaffold placed files incorrectly. The Next.js app code lives inside an `app/` subdirectory but the project root already has `next.config.ts`, `tsconfig.json`, and `package.json` at the root level. The `app/` directory is a container — the `src/` folder inside it should be at the project root, not nested under `app/`. Same for config files (`app/next.config.ts`, `app/tsconfig.json` duplicate the root ones).

**Fix**: Move `app/src/`, `app/public/`, and `app/tailwind.config.ts` to the project root. Delete the `app/` wrapper directory. This gives us the correct layout:

```
reelcast/
├── src/
│   ├── app/           # Next.js routes
│   ├── components/    # UI components
│   ├── hooks/
│   ├── lib/
│   └── types/
├── drizzle/           # SQL migrations (drizzle-kit)
├── scripts/           # One-off scripts (e.g. db-cron.ts)
├── public/            # Static assets
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

---

## Phase 0 — Project Bootstrapping & Tooling

The foundation. Everything else depends on this phase being correct.

### 0.1 Restructure project layout
- Move `app/src/` → `src/`
- Move `app/public/` → `public/`
- Move `app/tailwind.config.ts` → root
- Delete empty `app/` directory
- Update `tsconfig.json` paths if needed

### 0.2 Package manager & scripts
- Replace `npm` with `bun` throughout
- Install dependencies with `bun install`
- Add these scripts to `package.json`:

```json
{
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "eslint . --ext .ts,.tsx",
    "typecheck": "tsc --noEmit",
    "check": "bun run typecheck && bun run lint",
    "db:generate": "bunx --bun drizzle-kit generate",
    "db:migrate": "bunx --bun drizzle-kit migrate",
    "test": "bun --env-file=.env.local test --timeout 60000"
  }
}
```

### 0.3 Additional dependencies
```bash
bun add @supabase/supabase-js @supabase/ssr drizzle-orm postgres @tanstack/react-query react-dom
bun add -d drizzle-kit
bun add -d @typescript-eslint/eslint-plugin @typescript-eslint/parser
bun add -d prettier eslint-config-prettier
bun add clsx tailwind-merge lucide-react
bun add zod
```

### 0.4 Pre-commit / CI automation
- Add `typecheck` and `lint` to a `pre-commit` hook or CI pipeline
- Create `.prettierrc` for formatting consistency

---

## Phase 1 — Design System Foundation (YouTube Theme)

This is the visual DNA of the entire app. Every component depends on these tokens being defined first.

### 1.1 Global colors (`globals.css`)

YouTube-inspired dark-first palette:

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--background` | `#ffffff` | `#0f0f0f` | Page background |
| `--foreground` | `#0f0f0f` | `#f1f1f1` | Primary text |
| `--card` | `#f9f9f9` | `#1a1a1a` | Card surfaces |
| `--card-foreground` | `#0f0f0f` | `#f1f1f1` | Card text |
| `--primary` | `#ff0000` | `#ff0000` | CTAs, active states (YouTube red) |
| `--primary-foreground` | `#ffffff` | `#ffffff` | Text on primary |
| `--secondary` | `#f2f2f2` | `#272727` | Muted backgrounds, hover states |
| `--secondary-foreground` | `#0f0f0f` | `#f1f1f1` | Text on secondary |
| `--muted` | `#f2f2f2` | `#272727` | Disabled/inactive |
| `--muted-foreground` | `#606060` | `#aaaaaa` | Secondary text, timestamps |
| `--accent` | `#f2f2f2` | `#272727` | Hover highlights |
| `--destructive` | `#dc2626` | `#ef4444` | Error states |
| `--border` | `#e5e5e5` | `#333333` | Card/input borders |
| `--ring` | `#ff0000` | `#ff0000` | Focus rings (YouTube red) |
| `--sidebar` | `#ffffff` | `#1a1a1a` | Sidebar background |
| `--success` | `#2ba640` | `#2ba640` | Success/published states |
| `--warning` | `#f59e0b` | `#f59e0b` | Warning/generating states |

### 1.2 Typography

YouTube uses a clean, system-first approach. We'll use Inter for body and Roboto (YouTube's actual typeface) as the identity font:

```css
--font-sans: 'Inter', 'Roboto', system-ui, -apple-system, sans-serif;
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;
```

Scale (using Tailwind's default + YouTube proportions):
| Token | Size | Line-height | Usage |
|---|---|---|---|
| `text-xs` | 12px | 16px | Timestamps, metadata |
| `text-sm` | 14px | 20px | Secondary text, labels |
| `text-base` | 16px | 24px | Body text |
| `text-lg` | 18px | 28px | Card titles |
| `text-xl` | 20px | 28px | Section headers |
| `text-2xl` | 24px | 32px | Page titles |
| `text-3xl` | 30px | 36px | Hero text |

### 1.3 Tailwind config (`tailwind.config.ts`)
- Extend theme with all color tokens
- Configure dark mode via `class` strategy
- Add custom animations (fade-in, slide-up, pulse)
- Set up container queries if needed

### 1.4 Root layout (`src/app/layout.tsx`)
- Import Google Fonts (Inter + Roboto)
- Apply the TanStack Query provider and the Supabase auth-state provider (`src/components/providers.tsx`)
- Set metadata (title, description, icons, PWA manifest)
- Apply dark class on `<html>` (YouTube is dark-first)

### 1.5 Utility functions (`src/lib/utils.ts`)
- `cn()` — clsx + tailwind-merge helper
- `formatDate()` — relative timestamps like YouTube
- `formatDuration()` — video duration display
- `formatViewCount()` — compact number display (1.2M, 340K)
- `truncate()` — text truncation with ellipsis

### 1.6 Constants (`src/lib/constants.ts`)
- Video status enum: `draft | queued | generating | ready | scheduled | publishing | published | failed`
- Job status enum
- File size limits
- Supported video formats
- AI preset options

---

## Phase 2 — Type Definitions & Shared Components

### 2.1 Type definitions
- `src/types/video.ts` — Video, Draft, VideoStatus types
- `src/types/job.ts` — GenerationJob, PublishJob, JobStatus
- `src/types/settings.ts` — UserSettings, AIConfig, NotificationPrefs
- `src/types/analytics.ts` — AnalyticsResponse, VideoMetrics, ChannelMetrics

### 2.2 Base UI components (`src/components/ui/`)
Build all 15 shadcn/ui-style primitives:
- `button.tsx` — variants: default, destructive, outline, secondary, ghost, link
- `card.tsx` — Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter
- `badge.tsx` — variants: default, secondary, destructive, outline, success, warning
- `input.tsx` — with label integration
- `textarea.tsx`
- `label.tsx`
- `select.tsx` — using Radix or custom
- `switch.tsx` — toggle
- `dialog.tsx` — modal
- `dropdown-menu.tsx`
- `tabs.tsx` — Tabs, TabsList, TabsTrigger, TabsContent
- `tooltip.tsx`
- `progress.tsx` — for uploads and generation
- `skeleton.tsx` — loading states
- `table.tsx` — Table, TableHeader, TableBody, TableRow, TableCell

### 2.3 Shared components (`src/components/shared/`)
- `loading-spinner.tsx`
- `empty-state.tsx` — icon + title + description + optional CTA
- `error-boundary.tsx`
- `confirm-dialog.tsx`

---

## Phase 3 — Layout Shell & Navigation

### 3.1 App shell (`src/app/(app)/layout.tsx`)
- Auth guard (redirect to `/sign-in` if unauthenticated)
- Sidebar + Topbar layout
- Query + auth providers already in root layout

### 3.2 Sidebar (`src/components/layout/sidebar.tsx`)
- Logo
- Navigation links: Dashboard, Upload, Drafts, Schedule, History, Analytics
- Settings link at bottom
- Collapse/expand
- Active state highlighting (YouTube red accent)

### 3.3 Topbar (`src/components/layout/topbar.tsx`)
- Breadcrumb or page title
- User avatar + dropdown (profile, settings, sign out)
- Notification indicator

### 3.4 Page header (`src/components/layout/page-header.tsx`)
- Reusable title + description + optional action button

### 3.5 Auth layouts
- `(auth)/layout.tsx` — centered card layout
- `(marketing)/layout.tsx` — full-width with nav

---

## Phase 4 — Postgres Schema & Core Backend

### 4.1 Database schema (`src/db/schema.ts`, migrations in `drizzle/`)
Tables: `users`, `videos`, `jobs`, `settings`, plus tasks, notifications, analytics and billing tables

### 4.2 Auth helpers (`src/server/auth.ts`)
- Get authenticated user ID from context
- Validate resource ownership

### 4.3 User management
- `src/server/modules/users.ts` — current user
- The user row is created on first request (`ensureUser` in `src/server/auth.ts`); no auth webhook needed

### 4.4 Core queries & mutations
- `src/server/modules/videos.ts` — Video CRUD, status transitions
- `src/server/modules/jobs.ts` — Job queue queries, retry
- `src/server/modules/settings.ts` — User settings get/set
- Browser calls go through `POST /api/rpc` (`src/server/rpc/`)

---

## Phase 5 — Core Frontend Pages

### 5.1 Landing page (`src/app/(marketing)/page.tsx`)
- Hero, features, CTA

### 5.2 Auth pages
- Sign in / Sign up with Supabase Auth (email and Google)

### 5.3 Dashboard (`src/app/(app)/dashboard/page.tsx`)
- Recent drafts grid
- Active jobs with live status
- Quick upload CTA
- Pending schedules summary

### 5.4 Upload (`src/app/(app)/upload/page.tsx`)
- Drag-and-drop upload widget
- Progress tracking
- Auto-create draft on completion

### 5.5 Drafts library (`src/app/(app)/drafts/page.tsx`)
- Grid/list of video cards
- Status badges
- Filter by status

---

## Phase 6 — Video Detail & Generation Pipeline

### 6.1 Video detail page (`src/app/(app)/video/[id]/page.tsx`)
- Video preview
- AI config form
- Metadata editor
- Generation controls
- Publish controls

### 6.2 Video components
- `video-card.tsx`, `video-status-badge.tsx`, `video-uploader.tsx`
- `upload-progress.tsx`, `ai-config-form.tsx`
- `metadata-editor.tsx`, `generation-trigger.tsx`

### 6.3 Generation pipeline
- `src/server/jobs/handlers/generation.ts` — generation job handler
- `src/server/modules/actions/metadata.ts` — AI metadata generation
- `src/server/lib/ai.ts` — AI engine wrapper
- `src/server/lib/generation/generationJob.ts`

### 6.4 Custom hooks
- `use-upload.ts`, `use-video-status.ts`

---

## Phase 7 — Publishing & Scheduling

### 7.1 Publishing
- `src/server/lib/publish/run.ts` — YouTube publish job (resumable upload)
- `src/server/lib/youtube.ts` — YouTube API client
- `src/app/api/youtube/callback/route.ts` — OAuth callback
- `publish-controls.tsx`, `schedule-picker.tsx`

### 7.2 Scheduling
- `src/server/jobs/handlers/publish.ts` — runs via the job runner (`/api/cron/tick`)
- `src/app/(app)/schedule/page.tsx`
- `job-calendar.tsx`, `job-queue-list.tsx`
- `use-job-queue.ts`

---

## Phase 8 — Storage, Notifications & Settings

### 8.1 Storage
- `src/app/api/cloudinary/sign/route.ts` — signed Cloudinary uploads
- `src/server/lib/cloudinary.ts` — Cloudinary helpers

### 8.2 Telegram notifications
- `src/server/lib/notify.ts` — Telegram / Discord / email fan-out
- `src/components/settings/telegram-connect-card.tsx`

### 8.3 Settings pages
- General, AI defaults, YouTube connection, Telegram, Notifications

---

## Phase 9 — Analytics & History

### 9.1 Analytics
- `src/server/modules/actions/youtubeAnalytics.ts`
- `src/app/(app)/analytics/page.tsx`
- `metrics-overview.tsx`, `video-metrics-row.tsx`, `performance-chart.tsx`
- `use-analytics.ts`

### 9.2 History
- `src/app/(app)/history/page.tsx`
- `job-log-row.tsx`, `retry-button.tsx`

---

## Environment Variables

### Root `.env.example`

```env
# ── Supabase (auth) ────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...

# ── Supabase Postgres ──────────────────────────────────
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
DATABASE_URL_DIRECT=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

# ── App secrets ────────────────────────────────────────
APP_ENCRYPTION_KEY=base64-32-bytes   # openssl rand -base64 32
CRON_SECRET=hex-32-bytes             # openssl rand -hex 32

# ── Cloudinary ─────────────────────────────────────────
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# ── YouTube / Google OAuth ─────────────────────────────
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
YOUTUBE_REDIRECT_URI=http://localhost:3000/api/youtube/callback
# For production deploys, also add:
# https://reelcast-kappa.vercel.app/api/youtube/callback

# ── Telegram Bot ───────────────────────────────────────
TELEGRAM_BOT_TOKEN=123456:ABC-DEF
TELEGRAM_BOT_USERNAME=ReelCastNotifyBot

# ── AI Engine ──────────────────────────────────────────
AI_ENGINE_API_KEY=xxx
AI_ENGINE_ENDPOINT=https://api.ai-engine.example.com/v1

# ── App ────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_NAME=ReelCast
```

---

## Automated Checks

### TypeScript (`bun run typecheck`)
Runs `tsc --noEmit` — catches type errors before runtime.

### Lint (`bun run lint`)
Runs ESLint with `eslint-config-next` (core-web-vitals + typescript).

### Combined (`bun run check`)
Runs both typecheck and lint sequentially.

### Pre-push hook (optional via husky or simple git hook)
```bash
#!/bin/sh
bun run check
if [ $? -ne 0 ]; then
  echo "TypeScript or lint errors found. Fix before pushing."
  exit 1
fi
```

---

## Build Order Priority

The most essential file to start with is **`src/app/globals.css`** — it defines every color token and font the rest of the UI depends on. From there:

1. `globals.css` → design tokens
2. `tailwind.config.ts` → wire tokens into utility classes
3. `src/lib/utils.ts` → `cn()` helper (every component imports this)
4. `src/app/layout.tsx` → root layout with providers & fonts
5. `src/components/ui/button.tsx` → first UI primitive (everything uses buttons)
6. `src/components/ui/card.tsx` → second most-used primitive
7. Then build outward: types → more UI → layouts → pages → backend
