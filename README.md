# ReelCast

AI-assisted YouTube publishing. Upload a video (or describe one and let Google Veo generate it), let AI write the title, description, tags, captions and thumbnail, then schedule it or let auto-publish post it to your channel — all in the background.

Built with Next.js 16, Supabase (Auth + Postgres), Drizzle ORM, and a portable Postgres job queue. Billing runs on Pesapal.

## Quick start

Requires [bun](https://bun.sh) and a Supabase project.

```bash
bun install
cp .env.example .env.local   # then fill in the values (see below)
bun run db:migrate           # create the tables in your Supabase database
bun run dev                  # http://localhost:3000
```

`bun run dev` is the only process you need. The background job runner (publishing, generation, schedules) runs inside the dev server.

### Environment

Every variable is documented in [`.env.example`](.env.example). The ones you need to get started:

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project (Auth) |
| `DATABASE_URL` | Supabase Postgres, Transaction pooler (port 6543) |
| `DATABASE_URL_DIRECT` | Supabase Postgres, Session pooler (port 5432), used by migrations |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts tokens and keys at rest |
| `CRON_SECRET` | Protects `/api/cron/tick` (`openssl rand -hex 32`) |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Video storage |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | YouTube OAuth |
| `GEMINI_API_KEY` | Metadata and Veo (an admin can also set it in the app) |

## Scripts

| Command | What it does |
|---|---|
| `bun run dev` | Development server (with the in-process job runner) |
| `bun run build` / `bun run start` | Production build and server |
| `bun run check` | Typecheck + lint |
| `bun run test <file>` | Run tests, e.g. `bun run test src/server/rpc/rpc.test.ts` |
| `bun run db:generate` | Generate a SQL migration after editing `src/db/schema.ts` |
| `bun run db:migrate` | Apply migrations to the database |

Tests are DB-backed (they run in transactions that are always rolled back) and use the real database from `.env.local`, so a full run is slow; run the files you touched.

## How it works

- **Browser → server** goes through one typed endpoint, `POST /api/rpc`. Server functions live in `src/server/modules/` and are registered in `src/server/rpc/registry.ts`. In the browser, `src/lib/rpc/client.ts` provides `api`, `useQuery`, `useMutation` and `useAction`.
- **Data** is in Supabase Postgres (`src/db/schema.ts`, migrations in `drizzle/`). Every table is locked to the server: the public API has no access, and secrets are encrypted at rest.
- **Background work** runs on a Postgres queue (`src/server/jobs/`). One function, `runTick()`, claims due jobs and tasks and runs the periodic sweeps. In development a timer calls it every 5 seconds; in production Supabase `pg_cron` calls `/api/cron/tick` every minute.
- **Files** are uploaded straight from the browser to Cloudinary and streamed to YouTube when published.
- **Billing** uses Pesapal. Pesapal notifications are never trusted on their own; each is re-verified with Pesapal before a plan changes.

More detail: [`IDEA.md`](IDEA.md) (product and architecture overview), [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) (same, plus folder structure), [`docs/SPEC.md`](docs/SPEC.md) (full specification), [`docs/PRODUCT_ROADMAP.md`](docs/PRODUCT_ROADMAP.md) (what is built and what is next).

## Deploying

ReelCast runs on any Node host that can serve a Next.js app, with Supabase for Auth and Postgres.

1. Set the environment variables from `.env.example` on your host (`NEXT_PUBLIC_APP_URL` must be your public https URL).
2. Run `bun run db:migrate` against the production database.
3. Install the production job schedule once, using the deployed URL:

   ```bash
   bun --env-file=.env.local scripts/db-cron.ts https://your-domain.example
   ```

   This makes Supabase `pg_cron` call `/api/cron/tick` every minute. To remove it later, pass `--remove`.
4. In **Admin → Settings**, add your Pesapal credentials and register the payment-notification (IPN) URL.
5. Add `https://your-domain.example/api/youtube/callback` to your Google OAuth authorized redirect URIs (the YouTube connection needs the `yt-analytics.readonly` scope for analytics), and add `https://your-domain.example/auth/callback` to the redirect URLs in your Supabase Auth settings.

Notes for small hosting plans: the job runner is built to stay within a ~300 s function limit (long uploads and generations resume across runs), and the schedule is driven by Supabase rather than the host's cron, so a daily-only host cron is fine.

## Project conventions

- Use **bun**, not npm.
- `src/middleware.ts` keeps its name on purpose; don't rename it.
- Server code (`src/server`, `src/db`) must never be imported from client components.
- Secrets never leave the server: return data through the DTO builders in `src/server/lib/dto.ts`, never raw rows from `users`, `settings`, `youtube_channels` or `platform_settings`.
- This version of Next.js has breaking changes from older releases; check `node_modules/next/dist/docs/` before using a Next.js API you are unsure about.
