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
├── convex/            # Backend
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
    "convex:dev": "convex dev"
  }
}
```

### 0.3 Additional dependencies
```bash
bun add @clerk/nextjs convex react-dom
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
- Apply `ConvexProvider` and `ClerkProvider`
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
- Convex + Clerk providers already in root layout

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

## Phase 4 — Convex Schema & Core Backend

### 4.1 Database schema (`convex/schema.ts`)
Tables: `users`, `videos`, `jobs`, `settings`

### 4.2 Auth helpers (`convex/lib/auth.ts`)
- Get authenticated user ID from context
- Validate resource ownership

### 4.3 User management
- `convex/users.ts` — CRUD for user records
- Clerk webhook handler (`src/app/api/webhooks/clerk/route.ts`)

### 4.4 Core queries & mutations
- `convex/videos.ts` — Video CRUD, status transitions
- `convex/jobs.ts` — Job queue queries, status mutations
- `convex/settings.ts` — User settings get/set

---

## Phase 5 — Core Frontend Pages

### 5.1 Landing page (`src/app/(marketing)/page.tsx`)
- Hero, features, CTA

### 5.2 Auth pages
- Sign in / Sign up with Clerk components

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
- `convex/actions/generation.ts` — AI generation action
- `convex/actions/metadata.ts` — AI metadata generation
- `convex/lib/ai.ts` — AI engine wrapper
- `convex/scheduled/runGeneration.ts`

### 6.4 Custom hooks
- `use-upload.ts`, `use-video-status.ts`

---

## Phase 7 — Publishing & Scheduling

### 7.1 Publishing
- `convex/actions/publish.ts` — YouTube publish action
- `convex/lib/youtube.ts` — YouTube API client
- `src/app/api/youtube/callback/route.ts` — OAuth callback
- `publish-controls.tsx`, `schedule-picker.tsx`

### 7.2 Scheduling
- `convex/scheduled/runPublish.ts`
- `src/app/(app)/schedule/page.tsx`
- `job-calendar.tsx`, `job-queue-list.tsx`
- `use-job-queue.ts`

---

## Phase 8 — Storage, Notifications & Settings

### 8.1 Storage
- `convex/actions/storage.ts` — Presigned URL generation
- `convex/lib/r2.ts` — R2 client wrapper

### 8.2 Telegram notifications
- `convex/actions/telegram.ts`
- `convex/lib/telegram.ts`
- `src/components/settings/telegram-connect-card.tsx`

### 8.3 Settings pages
- General, AI defaults, YouTube connection, Telegram, Notifications

---

## Phase 9 — Analytics & History

### 9.1 Analytics
- `convex/actions/analytics.ts`
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
# ── Clerk ──────────────────────────────────────────────
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
CLERK_SECRET_KEY=sk_test_xxx
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
CLERK_WEBHOOK_SECRET=whsec_xxx

# ── Convex ─────────────────────────────────────────────
CONVEX_DEPLOYMENT=dev:your-deployment-name
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://your-deployment.convex.site

# ── Cloudflare R2 ──────────────────────────────────────
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=reelcast-videos
R2_PUBLIC_URL=https://cdn.reelcast.app

# ── YouTube / Google OAuth ─────────────────────────────
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx
YOUTUBE_REDIRECT_URI=https://your-domain.com/api/youtube/callback

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
