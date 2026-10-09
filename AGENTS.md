<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Reelcast project map

Stack: Next.js 16, Supabase Auth + Postgres (Drizzle ORM), a Postgres job queue, Cloudinary storage, Pesapal billing. There is no Convex, Clerk or PayPal. See `README.md` and `docs/PROJECT-GUIDE.md` for the full picture.

- **Package manager:** bun only. `src/middleware.ts` keeps the name `middleware`; never rename it to `proxy`.
- **Browser → server** goes only through `POST /api/rpc`. Add a function in `src/server/modules/<domain>.ts` with `query`/`mutation`/`action` (`src/server/rpc/define.ts`); modules are listed in `src/server/rpc/registry.ts`. A module file may export only rpc definitions; put helpers in `src/server/lib/`. UI code uses `api`, `useQuery`, `useMutation`, `useAction` from `src/lib/rpc/client.ts`.
- **Always** scope data by `ctx.userId` and verify ownership of any id the client sends. Admin functions use `auth: "admin"`. Never return raw rows from `users`, `settings`, `youtube_channels`, `platform_settings` or `payment_*`; use the DTO builders (`src/server/lib/dto.ts`). Secrets are stored encrypted (`src/server/crypto.ts`).
- **Database:** edit `src/db/schema.ts`, run `bun run db:generate`, review the SQL in `drizzle/`, then `bun run db:migrate`. Every table must be RLS-locked with no API-role grants (see `drizzle/0001_security.sql`). Postgres is READ COMMITTED: make read-modify-write a single atomic statement; use `consumeQuota` (`src/server/lib/usage.ts`) for plan limits.
- **Background work** lives in `src/server/jobs/` (queue, `runTick`, one handler file per domain). Handlers must be idempotent, finish well under ~4 minutes, and resume long work with `deferMs`. Never call external APIs inside a DB transaction.
- **Tests:** `bun run test <file>` (bun test, scoped to `src/`, DB-backed with rolled-back transactions via `src/server/testing.ts`). Never run bare `bun test` (it would pick up `scratch/`). `bun run check` runs typecheck + lint.