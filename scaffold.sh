#!/bin/bash

# ============================================================
#  ReelCast — Project Scaffold Script
#  Run: chmod +x scaffold.sh && ./scaffold.sh
#  Creates the full folder structure with placeholder files
# ============================================================

set -e

PROJECT="."

echo ""
echo "🎬  Scaffolding ReelCast project..."
echo ""

# ── Root ────────────────────────────────────────────────────
mkdir -p "$PROJECT"
cd "$PROJECT"

touch .gitignore
touch .env.example
touch package.json
touch README.md

# ── app/public ──────────────────────────────────────────────
mkdir -p app/public/icons
touch app/public/manifest.json
touch app/public/sw.js

# ── app/src/app/(auth) ──────────────────────────────────────
mkdir -p app/src/app/\(auth\)/sign-in
mkdir -p app/src/app/\(auth\)/sign-up
touch app/src/app/\(auth\)/sign-in/page.tsx
touch app/src/app/\(auth\)/sign-up/page.tsx
touch app/src/app/\(auth\)/layout.tsx

# ── app/src/app/(marketing) ─────────────────────────────────
mkdir -p app/src/app/\(marketing\)
touch app/src/app/\(marketing\)/page.tsx
touch app/src/app/\(marketing\)/layout.tsx

# ── app/src/app/(app) ───────────────────────────────────────
mkdir -p app/src/app/\(app\)/dashboard
mkdir -p app/src/app/\(app\)/upload
mkdir -p app/src/app/\(app\)/drafts
mkdir -p app/src/app/\(app\)/video/\[id\]
mkdir -p app/src/app/\(app\)/schedule
mkdir -p app/src/app/\(app\)/history
mkdir -p app/src/app/\(app\)/analytics
mkdir -p app/src/app/\(app\)/settings/general
mkdir -p app/src/app/\(app\)/settings/ai
mkdir -p app/src/app/\(app\)/settings/youtube
mkdir -p app/src/app/\(app\)/settings/telegram
mkdir -p app/src/app/\(app\)/settings/notifications

touch app/src/app/\(app\)/layout.tsx
touch app/src/app/\(app\)/dashboard/page.tsx
touch app/src/app/\(app\)/upload/page.tsx
touch app/src/app/\(app\)/drafts/page.tsx
touch app/src/app/\(app\)/video/\[id\]/page.tsx
touch app/src/app/\(app\)/schedule/page.tsx
touch app/src/app/\(app\)/history/page.tsx
touch app/src/app/\(app\)/analytics/page.tsx
touch app/src/app/\(app\)/settings/page.tsx
touch app/src/app/\(app\)/settings/general/page.tsx
touch app/src/app/\(app\)/settings/ai/page.tsx
touch app/src/app/\(app\)/settings/youtube/page.tsx
touch app/src/app/\(app\)/settings/telegram/page.tsx
touch app/src/app/\(app\)/settings/notifications/page.tsx

# ── app/src/app/api ─────────────────────────────────────────
mkdir -p app/src/app/api/webhooks/clerk
mkdir -p app/src/app/api/youtube/callback

touch app/src/app/api/webhooks/clerk/route.ts
touch app/src/app/api/youtube/callback/route.ts

# ── app/src/app root files ──────────────────────────────────
touch app/src/app/layout.tsx
touch app/src/app/not-found.tsx
touch app/src/app/error.tsx

# ── app/src/components/ui ───────────────────────────────────
mkdir -p app/src/components/ui
for file in button badge card dialog dropdown-menu input label progress select skeleton switch table tabs textarea tooltip; do
  touch "app/src/components/ui/${file}.tsx"
done

# ── app/src/components/layout ───────────────────────────────
mkdir -p app/src/components/layout
touch app/src/components/layout/sidebar.tsx
touch app/src/components/layout/topbar.tsx
touch app/src/components/layout/page-header.tsx

# ── app/src/components/video ──────────────────────────────
mkdir -p app/src/components/video
touch app/src/components/video/video-card.tsx
touch app/src/components/video/video-status-badge.tsx
touch app/src/components/video/video-uploader.tsx
touch app/src/components/video/upload-progress.tsx
touch app/src/components/video/ai-config-form.tsx
touch app/src/components/video/metadata-editor.tsx
touch app/src/components/video/generation-trigger.tsx

# ── app/src/components/publish ──────────────────────────────
mkdir -p app/src/components/publish
touch app/src/components/publish/publish-controls.tsx
touch app/src/components/publish/schedule-picker.tsx

# ── app/src/components/schedule ─────────────────────────────
mkdir -p app/src/components/schedule
touch app/src/components/schedule/job-calendar.tsx
touch app/src/components/schedule/job-queue-list.tsx

# ── app/src/components/analytics ────────────────────────────
mkdir -p app/src/components/analytics
touch app/src/components/analytics/metrics-overview.tsx
touch app/src/components/analytics/video-metrics-row.tsx
touch app/src/components/analytics/performance-chart.tsx

# ── app/src/components/history ──────────────────────────────
mkdir -p app/src/components/history
touch app/src/components/history/job-log-row.tsx
touch app/src/components/history/retry-button.tsx

# ── app/src/components/settings ─────────────────────────────
mkdir -p app/src/components/settings
touch app/src/components/settings/ai-defaults-form.tsx
touch app/src/components/settings/youtube-connect-card.tsx
touch app/src/components/settings/telegram-connect-card.tsx

# ── app/src/components/shared ───────────────────────────────
mkdir -p app/src/components/shared
touch app/src/components/shared/empty-state.tsx
touch app/src/components/shared/error-boundary.tsx
touch app/src/components/shared/loading-spinner.tsx
touch app/src/components/shared/confirm-dialog.tsx

# ── app/src/hooks ───────────────────────────────────────────
mkdir -p app/src/hooks
touch app/src/hooks/use-upload.ts
touch app/src/hooks/use-video-status.ts
touch app/src/hooks/use-job-queue.ts
touch app/src/hooks/use-analytics.ts

# ── app/src/lib ───────────────────────────────────────────
mkdir -p app/src/lib
touch app/src/lib/convex.ts
touch app/src/lib/clerk.ts
touch app/src/lib/utils.ts
touch app/src/lib/constants.ts
touch app/src/lib/validators.ts

# ── app/src/types ───────────────────────────────────────────
mkdir -p app/src/types
touch app/src/types/video.ts
touch app/src/types/job.ts
touch app/src/types/analytics.ts
touch app/src/types/settings.ts

# ── app root config files ───────────────────────────────────
touch app/next.config.ts
touch app/tailwind.config.ts
touch app/tsconfig.json
touch app/.env.local
touch app/.env.example

# ── convex/ ─────────────────────────────────────────────────
mkdir -p convex/actions
mkdir -p convex/scheduled
mkdir -p convex/lib
mkdir -p convex/_generated

touch convex/schema.ts
touch convex/users.ts
touch convex/videos.ts
touch convex/jobs.ts
touch convex/settings.ts

# ── convex/actions ──────────────────────────────────────────
touch convex/actions/storage.ts
touch convex/actions/generation.ts
touch convex/actions/publish.ts
touch convex/actions/metadata.ts
touch convex/actions/analytics.ts
touch convex/actions/telegram.ts

# ── convex/scheduled ────────────────────────────────────────
touch convex/scheduled/runGeneration.ts
touch convex/scheduled/runPublish.ts

# ── convex/lib ─────────────────────────────────────────────
touch convex/lib/youtube.ts
touch convex/lib/r2.ts
touch convex/lib/ai.ts
touch convex/lib/telegram.ts
touch convex/lib/auth.ts

# ── convex/_generated ───────────────────────────────────────
touch convex/_generated/api.d.ts
touch convex/_generated/dataModel.d.ts
touch convex/_generated/server.d.ts

echo "✅  Done! Project scaffolded at ./${PROJECT}"
echo ""
echo "Next steps:"
echo "  1. cd ${PROJECT}/app && npm install"
echo "  2. cp .env.example .env.local and fill in your keys"
echo "  3. npx convex dev to start the Convex backend"
echo ""