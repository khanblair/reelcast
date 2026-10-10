# Scaling ladder: audit and progress tracker

Source flow: `system-design-step-by-step.md` (the "break it, then fix one thing" guide). This file is the
audit of Reelcast against that flow and the live tracker for every fix that comes out of it.

- Audit date: 2026-10-10. Branch: `chore/scaling-ladder`.
- Scale today (measured, see F-0): **2 users, 0 videos, 0 jobs, 14 MB database.** The guide's golden rule
  applies: *never add a box you can't name the problem for.* A step with no nameable problem is recorded as
  `SKIP` together with the measured trigger that would reopen it.

## How to read this

**Evidence tags.** `[live]` = I ran a read-only query or request against the real system. `[code path:line]` =
I read those lines myself. `[agent path:line]` = reported by a read-only audit agent; the claims I could
spot-check are marked "checked". `[NOT VERIFIED]` = could not be established from here.

**Status.** `TODO` not started · `DOING` in progress · `DONE` merged-ready and verified · `BLOCKED` needs a
decision or access from the owner · `SKIP` deliberately not done (trigger recorded) · `OBS` open observation.

**Gate.** `G` = touches production, a protected file, a paid/external service or a download, so it waits for an
explicit yes. Everything else is an ordinary code change, reviewed in its PR.

**Severity.** `P0` blocks a safe production launch · `P1` should fix before real users · `P2` nice to have.

---

## 1. Verified environment facts (F-0)

| # | Fact | Evidence |
|---|---|---|
| 1 | **Dev and prod are the same database.** `.env.local` and `.env.prod` hold the same Supabase project, pooler, password and `APP_ENCRYPTION_KEY`. | [live] compared by host/user/hash, no values printed |
| 2 | The database holds **2 users** (one admin), 0 videos, 0 jobs, 2 done tasks. | [live] row counts |
| 3 | **Nothing in production schedules the job tick.** `pg_cron` and `pg_net` are *available* but **not installed**; `vault.secrets` is empty, so `scripts/db-cron.ts` never ran against this database. The only thing ticking is a local `next dev` server (`job_schedules.last_run_at` advances while it runs). | [live] `pg_extension`, `pg_available_extensions`, `vault.secrets`; [code src/instrumentation.ts:6-8] |
| 4 | Production functions run in **`iad1`** (Washington DC); the database is in **`eu-north-1`** (Stockholm). No `vercel.json`, no `preferredRegion`. | [live] `x-vercel-id: …::iad1::…` on `/` and `/api/cron/tick` |
| 5 | Postgres 17.6, `max_connections` 60, `statement_timeout` 120 s (server default), `lock_timeout` 0, `idle_in_transaction_session_timeout` 0. No role-level override for the app role. | [live] `pg_settings`, `pg_roles.rolconfig` |
| 6 | RLS is on for every public table; `anon`/`authenticated`/`PUBLIC` have no grants. `service_role` keeps Supabase's default grants, but no service key exists in the app env. | [live] `pg_class`, `role_table_grants` |
| 7 | Supabase JWT signing key is **ES256** (asymmetric), so `getClaims()` verifies locally with no network call. | [live] public JWKS endpoint |
| 8 | `middleware.ts:48` calls `getUser()` = one Supabase Auth round trip per matched request. | [code src/middleware.ts:48] |
| 9 | Index set in the database equals `schema.ts` + migrations. Foreign keys with **no covering index**: `ideas.linked_video_id`, `payment_orders.reviewed_by`, `payment_orders.subscription_id`, `tasks.user_id`. | [live] `pg_indexes`, `pg_constraint` |
| 10 | The Vercel connector is signed into a different team and the CLI is not logged in, so project settings, cron config, env vars and plan are **not readable by me**. | [live] 403 / "Not authorized" |
| 11 | Vercel plan per docs: **Hobby, "non-commercial use only"**, while the app bills through Pesapal. | [code docs/SPEC.md:938] |
| 12 | A local Docker daemon is running (8 CPU, 8 GB). `postgres:16-alpine` is already pulled; Supabase images are not. | [live] `docker info/images` |
| 13 | pg_stat_statements shows 800 `insert into users … on conflict (id) do update set updated_at` calls averaging 13 s (max 99.8 s). **No code, git history or trigger produces that statement**, and the counter did not move between two checks (800 → 800): historical, not live. | [live] two samples; [code] repo-wide search |

---

## 2. The ladder, step by step

### Step 0 · Measure

*Guide:* latency percentiles, error rate, DB CPU, connections, slow queries, load test before launch.

*Reelcast today:* nothing measures production. No per-RPC timing (`rpc/route.ts`, `dispatch.ts:44-69`), no
error reporter, free-text logs without path or user, the tick logs nothing (its `errors[]` goes to pg_net),
no `/api/health`, no tick heartbeat reader, admin health shows only Cloudinary + token status, no load tool
exists. PostHog is client-side only and a no-op without a key. `[agent]` The statement counter exists but
only counts inside tests. `pg_stat_statements` is installed `[live]` and is the one free source of slow-query
data. Roadmap already lists uptime monitoring as a TODO `[agent docs/PRODUCT_ROADMAP.md:573]`.

*Verdict:* **gap.** Items M-1 … M-6.

### Free fixes · indexes, N+1, CDN

- N+1: done in PR #6 (statement counts asserted in tests).
- Indexes: all hot claim/sweep paths are indexed `[live]`. Real gaps are the 4 unindexed foreign keys and a
  few sweep predicates (D-2). **Tables hold ~0 rows, so `EXPLAIN` on live data proves nothing**; the benefit is
  shown on synthetic data in an isolated database (see §5).
- CDN: Cloudinary serves media; `/_next/static` is immutable `[agent]`. Two heavy assets
  (`fire2.gif` 2.3 MB, unused `public/videos/forex` 2.5 MB) `[agent]`. Not a measured problem → SKIP.

### Steps 2–3 · scale up / out, load balancer

Vercel does this. **Nothing to build.** The one real defect is **region** (F-0 #4): every statement crosses the
Atlantic. Fix R-1.

### Step 4 · stateless, shared session store

Already stateless `[agent]`: no per-instance state that is wrong with N instances, no disk writes, uploads go
direct to Cloudinary, OAuth state is a cookie, job claims and quotas are DB statements. Auth is Supabase
cookies + local ES256 verification in RPC `[live][code auth.ts:23]`. **No Redis needed.** The remaining
per-request cost is middleware `getUser()` (R-2).

### Step 5 · pooling, indexes, timeouts, pagination

- Pooling: done (transaction pooler, `max:1` per prod instance, FIFO gate). `DATABASE_POOL_MAX` knob exists.
- **Timeouts: none in the app.** Only the 120 s server default `[live]`. With a one-connection pool, one
  runaway or lock-blocked statement pins that instance's only connection and everything behind it `[agent]`.
  Fix D-1 (P0).
- Pagination: lists silently cap at 500/1000 with no cursor or total, so rows past the cap are invisible
  `[agent dto.ts:35]`. Not a problem at 0 videos → SKIP (trigger: any user near 400 videos).

### Step 6 · read replicas — **SKIP**

Not read-bound (2 users). Cost would be replication lag on billing/quota paths, which must stay on the primary.
*Reopen when:* database CPU > 70 % sustained from reads, confirmed in Supabase metrics.

### Step 7 · caching — **client only, no Redis**

The expensive part is **polling, not computation**: a focused dashboard makes about 900 RPCs/hour/tab
`[agent]`. Server caches are not justified (POST RPC is uncacheable by CDN; `use cache` needs
`cacheComponents`, per-instance memory). Fix R-3 (adaptive polling + longer `staleTime`).
**Never cache:** billing, usage/quota, plan, `isAdmin`, payment verification, claims, publish CAS, admin.
*Reopen when:* a read RPC shows > 200 ms p95 in M-1 data, or DB CPU is read-dominated.

### Step 8 · queues and workers

The queue exists (Postgres, `FOR UPDATE SKIP LOCKED`, exponential backoff 30 s→15 min, 3 attempts, stale
recovery, idempotent handlers). **A transactional outbox is already satisfied** because the queue is a table in
the same database; the enqueue sites that are not in the same transaction are listed in Q-2/Q-6.
Gaps: no tick scheduler in prod (F-2), no dead-letter visibility for tasks or sweeps, no queue-depth/heartbeat,
`billing.expiry` is not crash-safe, Veo/Files/Auth calls have no timeout. Items Q-1 … Q-9.

### Step 9 · sharding — **SKIP**

14 MB. First-line options when it matters (retention D-3, then partitioning `video_daily_stats` by day).
*Reopen when:* database > 8 GB or any single table > 50 M rows.

### Bonus · "don't sell the same seat twice"

Covered already `[agent, checked in part]`: exactly-once payment application (`UPDATE … applied_at IS NULL`
in the same transaction as the entitlement change, race test with real connections), `consumeQuota` atomic
upsert, publish de-duplication by partial unique index + CAS + lease. Remaining: rate limiting is absent
(only `contact.submit`), Gemini captions/thumbnails are unmetered `[checked: no metering call in either file]`,
and `/auth/callback` open redirect `[checked src/app/auth/callback/route.ts:13]`.

---

## 3. Tracker

Update the **Status** and **Verified by** columns as work lands. Every `DONE` row must name the test, command
or measurement that proves it.

### Foundation (safety before anything else)

| ID | Item | Sev | Gate | Status | Verified by |
|---|---|---|---|---|---|
| F-1 | Separate the database used by dev/tests from production. Option A: local Docker Postgres for DB-backed tests (no cost). Option B: second Supabase project (needed for pooler/region behaviour). Add a guard that makes the test suite refuse a non-local `DATABASE_URL` unless explicitly allowed. | P0 | G (B) | **DECIDED 2026-10-10: stays shared for now** (owner: a few real users live there). Consequence: no load, fault-injection or destructive runs; DB-backed tests must be made safe instead (F-1c). Revisit before launch. | – |
| F-1c | Make the existing DB-backed tests safe on a shared database: `race.test.ts` must use a synthetic user instead of the oldest real account; `queue.test.ts` `claimJobs` calls must filter to the test's own rows; `recoverStale`/`runTick` cases must not touch real due jobs. | P0 | – | TODO (after branch base) | tests pass; grep shows no test selects a real account; a "rows that existed before" snapshot is identical after the suite |
| F-1b | Guard dev behaviour that acts on prod data: `instrumentation.ts` 5 s ticker, and `kickRunner` (`kick.ts:9-21`, no env check) must only run against a non-prod database or with an explicit opt-in. `queue.test.ts` (`claimJobs` with no owner filter) and `race.test.ts` (rewrites the oldest real account's plan, restores in `afterAll`) must not run against prod. | P0 | G (changes dev loop) | BLOCKED on decision | unit tests for the guard; manual: dev server prints "tick disabled" |
| F-2 | Schedule the production tick: install `pg_cron` + `pg_net` and the cron job (`scripts/db-cron.ts`) **in the production database**; confirm `CRON_SECRET` matches in Vercel; confirm the first runs return 200. | P0 | G (prod DB) | **DONE 2026-10-10** (owner approved) | [live] pre-flight authenticated tick → HTTP 200 `ok:true` (proves Vercel's secret matches); after install `cron.job` `reelcast-tick` active `* * * * *`; `cron.job_run_details` 2/2 `succeeded`; `net._http_response` 200 `ok:true`. Still to prove: heartbeat advances with the dev server stopped (needs M-2). |
| F-3 | Production tick heartbeat + alert (see M-2, M-4). | P0 | – | TODO | heartbeat age test; external pinger configured by owner |
| F-4 | Vercel plan: Hobby is "non-commercial use only" (docs/SPEC.md:938) but billing is live. Owner decision. | P0 if billing is live | G (owner) | BLOCKED on you | owner confirms plan |
| F-5 | Backups / PITR / Supabase plan and compute size are not knowable from code. Owner confirms in the dashboard; one restore test. | P0 | G (owner) | BLOCKED on you | owner confirms |
| F-6 | Rotate the shared database password (it was printed into a read-only audit agent's transcript on this machine; also the natural moment to split dev/prod credentials). | P1 | G (owner) | BLOCKED on you | new `DATABASE_URL` in Vercel + local |

### Step 0 · measurement

| ID | Item | Sev | Gate | Status | Verified by |
|---|---|---|---|---|---|
| M-1 | One structured log line per RPC: path, ms, status/code, statement count, no PII; log `RpcError` INTERNAL; pluggable error-report hook in `toErrorBody`. | P1 | – | TODO | unit test on dispatch; line visible in `next dev` |
| M-2 | Tick: per-entry error logging, summary line, heartbeat row at end of each tick (`job_schedules` name `tick.heartbeat`, one statement). | P0 | – | TODO | tick test asserts heartbeat + error log |
| M-3 | Admin health: queue depth, oldest pending age, failed jobs/tasks, last tick age, sweep `last_error`. | P1 | – | TODO | admin module test + `api.admin` gate test passes |
| M-4 | `GET /api/health`: DB ping, tick freshness, missing-env report; public, minimal body (`ok`/`stale`/`degraded`); no secrets. | P1 | – | TODO | route test; stale heartbeat → 503 |
| M-5 | Env validation: startup warning + `/api/health` report for missing required vars (hard-fail is opt-in so a missing optional var cannot take prod down). | P1 | – | TODO | unit test of the validator |
| M-6 | Error reporting service (Sentry or similar). | P2 | G (new dep + account) | SKIP until M-1 hook is in; owner picks a service | – |
| M-7 | Load test baseline (p50/p95/p99, statement counts) with a bun script against a local app + local Postgres. | P1 | – | TODO | script output committed under docs/ |

### Step 3 / 4 · region, auth cost, request path

| ID | Item | Sev | Gate | Status | Verified by |
|---|---|---|---|---|---|
| R-1 | Function region next to the database (`arn1`): `vercel.json` `regions`. Every statement currently crosses the Atlantic. | P0 | G (deploys on merge; plan limits unknown) | BLOCKED on you | response header `x-vercel-id` shows `arn1` after deploy |
| R-2 | `middleware.ts:48` `getUser()` → `getClaims()` (ES256 verified locally). Removes one Auth round trip from every page request and prefetch. **Protected file.** | P1 | G (protected, auth) | BLOCKED on you | middleware behaviour test; auth flow checked by owner |
| R-3 | Adaptive polling: `refetchInterval` returns `false` when no job is in flight; longer `staleTime` for `users.current`, `settings.get`, analytics. | P1 | – | TODO | unit tests on the interval functions; RPC count per focused minute before/after |
| R-4 | `/auth/callback`: accept only same-origin relative `next` (`/…`, not `//` or `/\`). | P1 | – | TODO | table-driven test incl. `@evil.com`, `//evil.com`, `/\evil.com` |
| R-5 | `/api/rpc` hardening: body size cap, exact `application/json`, Origin check alongside `Sec-Fetch-Site`. | P2 | – | TODO | route tests |
| R-6 | Meter Gemini captions + thumbnails (no quota gate today). | P1 | – | TODO | test: over-limit call rejected, counter increments |
| R-7 | Pre-check YouTube quota before `searchByKeyword` (100 u) / `getContentGaps` (~525 u). | P1 | – | TODO | test with quota near limit |
| R-8 | Tighten `/api/cloudinary/sign` (per-user folder, allowed formats, random id) like the avatar signer. | P1 | – | TODO | route test; upload still works (owner) |
| R-9 | Rate limiting at the edge (Vercel Firewall on `/api/rpc`, `/api/cloudinary/*`, IPN). Plan availability unknown. | P1 before public launch | G (owner/dashboard) | BLOCKED on you | owner confirms rules |
| R-10 | Static landing page, GIF → video, delete unused `public/videos/forex`. | P2 | – | SKIP (trigger: marketing traffic or LCP regression) | – |

### Step 5 · database

| ID | Item | Sev | Gate | Status | Verified by |
|---|---|---|---|---|---|
| D-1 | Statement / lock / idle-in-transaction timeouts. **Experiment done (2026-10-10, [live], session-scoped, read-only):** the transaction pooler (port 6543) **ignores** both the postgres.js `connection: {statement_timeout…}` startup parameters and `options=-c statement_timeout=…` in the URL — `current_setting` stayed `2min` and `pg_sleep(8)` ran to completion in all three variants (baseline, startup parameter, `options`), standalone and inside `sql.begin`. `SET LOCAL` would need a transaction around every statement (extra round trips). The only mechanism left is **role-level**: `alter role postgres set statement_timeout = '30s'`, `lock_timeout = '10s'`, `idle_in_transaction_session_timeout = '60s'`. Side effect: it also applies to migrations and the dashboard SQL editor on that role (a long `create index` on a large table would be cancelled). Today the bound is the 120 s server default, so severity is P1, not P0. | P1 | G (`alter role` = prod DB) | BLOCKED on you | after applying: `pg_sleep(40)` is cancelled at ~30 s and the same connection serves the next statement (rerun `timeoutexp` experiment) |
| D-2 | One migration with the indexes that have a nameable problem: `ideas(linked_video_id)` (per-video cascade scan), `tasks(user_id)`, `tasks(locked_at) where running`, `payment_orders(subscription_id, created_at)`, `payment_orders(updated_at) where applied_at is null`, `payment_events(received_at)` + bounded purge. Plus a test that fails when an FK has no leading index. | P1 | G (migration = prod DB) | TODO (code), BLOCKED to apply | `EXPLAIN` on synthetic rows in the isolated DB: plan flips seq scan → index; FK-guard test |
| D-3 | Retention sweep (bounded batches): `tasks` done/cancelled/failed > 14 d, read `notifications` > 90 d, `youtube_quota_usage` > 90 d. | P1 | – (runs in prod only after deploy) | TODO | test: old rows deleted, young rows kept, batch bounded |
| D-5 | `cron.job_run_details` grows one row per minute (about 1,440/day) and Supabase does not prune it. Add a daily `pg_cron` job deleting rows older than 7 days (installed the same way as the tick job). | P2 | G (prod DB) | TODO | row count stays bounded after a day |
| D-4 | `latestPerVideo` / `getStats` rewrites, cursor/total on capped lists, `deleteAccount` URL-scan indexes, unused-index drop. | P2 | – | SKIP (trigger: any user > 400 videos, or `getStats` > 300 ms in M-1) | – |

### Step 8 · queue and background work

| ID | Item | Sev | Gate | Status | Verified by |
|---|---|---|---|---|---|
| Q-1 | `billing.expiry`: revoke entitlement atomically with the subscription update (one transaction per row) and heal rows left half-done. | P1 | – | TODO | test simulating a crash between the two statements |
| Q-2 | Generation: `jobs.create('generation')` moves the video to `queued` in the same transaction (as the publish path does) so a dropped browser leaves no stuck `queued` video. | P1 | – | TODO | test: no state where job exists without status, or vice versa |
| Q-3 | Visibility: failed tasks and sweep `last_error` in admin; re-enqueue sweep for auto-publish users whose chain died. | P1 | – | TODO | admin test; chain-recovery test |
| Q-4 | Timeouts on Veo submit/poll and Files API calls (`httpOptions.timeout`); budget-aware start (defer when too little tick budget remains). | P1 | – | TODO | test with a fake server that hangs: call aborts, job retries |
| Q-5 | `billing.reconcile` honours the tick deadline. | P2 | – | TODO | test with deadline in the past |
| Q-6 | Metadata slow path: refund quota if the enqueue throws; analytics enqueue-after-work crash window. | P2 | – | TODO | test |
| Q-7 | Fence final job updates with `status = 'processing'`; lock order in checkout vs apply (deadlock). | P2 | – | SKIP (needs race-test coverage first; self-heals via reconcile) | – |
| Q-8 | Veo double-submit window (needs an intent row). | P2 | – | SKIP (costs state; trigger: first real Veo spend) | – |

### Steps 6, 7 (server), 9

| ID | Item | Status | Reopen when |
|---|---|---|---|
| X-1 | Read replicas | SKIP | read-dominated DB CPU > 70 % sustained |
| X-2 | Redis / server cache | SKIP | a read RPC > 200 ms p95 in M-1 data |
| X-3 | Sharding / partitioning | SKIP | DB > 8 GB or a table > 50 M rows |

---

## 4. Decisions waiting on you

Answered 2026-10-10: shared DB stays; F-1b, R-1, R-2, D-2 may be prepared as PRs; F-2 executed; branch base = main.

Still open (nothing below moves until you answer):

1. **Merge PRs #6 (perf) and #7 (account summary)** so fix branches can start from a clean `main`. Code PRs wait on this.
2. **D-1 role-level timeouts** (`alter role postgres set statement_timeout = '30s'`, `lock_timeout = '10s'`, `idle_in_transaction_session_timeout = '60s'`): yes/no, and the values. It also affects migrations and the dashboard SQL editor on that role.
3. **F-4 Vercel plan** (Hobby is non-commercial while billing is live), **F-5 backups/PITR** confirmation, **F-6 password rotation**: dashboard-only, yours to do or confirm.
4. **R-9 edge rate limits** (Vercel Firewall rules): needs your dashboard; plan availability unknown.
5. **D-5 prune `cron.job_run_details`**: yes/no to installing a second small cron job.

---

## 5. Simulation and verification plan

What "passes" means here, and where each can run. **No test below is marked passed until it has run.**

| Scenario | Where it can run | Status |
|---|---|---|
| Concurrent job claims never double-claim | existing `queue.test.ts` | exists – must run on isolated DB only |
| Duplicate / replayed / racing IPN + callback apply once | existing `core.test.ts`, `race.test.ts` | exists – `race.test.ts` must stop using real accounts |
| Overlapping ticks | existing `tick.test.ts` | exists |
| Hung external call → timeout → job retry | new, fake HTTP server | TODO (Q-4) |
| Runaway statement is cancelled; pool recovers | new, local Postgres (+ real pooler later) | TODO (D-1) |
| Tick dies → heartbeat goes stale → health 503 | new unit test | TODO (M-2, M-4) |
| Crash between subscription update and revoke | new, fault-injection test | TODO (Q-1) |
| Browser drops between generation RPCs | new test | TODO (Q-2) |
| Open-redirect attempts | new table test | TODO (R-4) |
| Metered AI actions reject at the limit | new test | TODO (R-6) |
| Load: N concurrent users, p50/p95/p99 + statements/request | bun script, local app + local Postgres | TODO (M-7) |
| Load / region latency through the real pooler and Vercel | needs a **non-production** Supabase + Vercel target | BLOCKED (F-1 option B) |
| Rate-limit / abuse behaviour | needs edge rules | BLOCKED (R-9) |

Local Postgres cannot reproduce the Supabase transaction pooler (pipelining hang), cross-region latency or
`pg_cron`. Those are marked BLOCKED, not passed.

---

## 6. Open observations (not verified)

- Vercel project settings, env vars, plan, cron config, log retention: not readable by me.
- Supabase compute size, backups/PITR, connection-pool size: dashboard only.
- Whether Hobby function limits and `regions` allow `arn1` on this plan.
- Whether Link prefetch actually triggers middleware Auth hops for each nav item (inferred, build output not checked).
- Whether Google answers 200 to a status query on a finished resumable upload (affects a rare duplicate-publish window).
- The 800 historical `users` upserts at 13 s mean (F-0 #13): origin unknown, not live.

---

## 7. Change log

| Date | Change |
|---|---|
| 2026-10-10 | Audit complete: live database, HTTP, Docker checks + four read-only code audits (queue, request path, DB access, observability). Tracker created. |
| 2026-10-10 | Owner decisions: DB stays shared for now (so no load/fault-injection runs; unsafe tests will be made safe instead); F-1b, R-1, R-2, D-2 approved as PRs (never applied to prod by me); F-2 approved and executed; branch base = main after owner merges PRs #6 and #7. |
| 2026-10-10 | F-2 DONE: production tick scheduled and verified (see tracker). D-1 experiment recorded: pooler ignores client-side timeout settings, role-level `ALTER ROLE` is the only route. |
