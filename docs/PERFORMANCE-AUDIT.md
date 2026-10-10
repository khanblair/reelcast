# Performance audit: queries, round trips and request overhead

Why this exists: the app talks to a **remote** Postgres (Supabase, through the transaction pooler), so every SQL statement
is a network round trip (about 0.4-0.8 s from a dev machine). Latency is therefore decided by the **number of
statements** (and requests), not by how heavy a query is. This audit looked for N+1 queries (one query for a list, then one
per row), per-row writes, sequential statements that could be one, duplicate lookups, and per-request overhead, in five
areas: user-facing RPC modules, admin and billing, server libraries and the job runner, client request patterns, and
per-request overhead (middleware, auth, the database client).

Everything below marked **Done** has a test that proves (a) the result is identical to the old code and (b) the statement
count no longer grows with the number of rows (`countQueries`, see "Keeping it fast").

## 1. A production hang, found and fixed

With the production setting (`max: 1`, one connection per server instance) **concurrent statements never returned** through
the Supabase pooler. Reproduced against the real database with the real admin functions: `admin.stats.getStats`,
`admin.billing.overview`, `admin.health.getStorageHealth` and `admin.users.getWithDetails` all hung under production
settings, and `getStats` (6 concurrent queries against 5 connections) hung even with the development pool.

Cause: when more statements are issued at once than there are connections (any `Promise.all`, or any overlap on a single
connection), postgres.js writes the extra statements onto a connection that is still busy ("pipelining"), and the pooler never
answers. The obvious one-line fix, `max_pipeline: 0`, **breaks every transaction** (postgres.js reserves the connection for
`sql.begin` through a hook that only runs when pipelining is allowed), which the tests caught.

Fix: `limitConcurrency()` (`src/db/concurrency-limit.ts`) sits in front of the driver and never allows more statements in
flight than there are connections; a transaction holds one slot for its whole duration, and statements inside a transaction
or savepoint run one at a time. `Promise.all` still works as written; it runs as parallel as the pool allows, never wider.
After the fix all four admin RPCs return under production, production-with-a-pool-of-3 and development settings.
Tests: 12 unit tests against a fake driver, and 7 against the real pooler with the production options.

**Pool size.** `DATABASE_POOL_MAX` (default 1 in production, 5 otherwise) is now safe to raise. With a pool of 3 the same four
RPCs were noticeably faster (`getStats` 2.6 s to about 1 s on a repeat call), because independent queries then really run in parallel. It is your
call (see section 4): each warm serverless instance holds that many pooler connections.

Rejected: `fetch_types: false` (saves roughly 0.2-1.7 s per cold connection, but round-tripping a text array with commas,
quotes or braces returned different data, so tags could silently change).

## 2. What changed (all with tests)

### Client

| Change | Effect |
|---|---|
| Tab refocus no longer clears the whole data cache (it cleared on every `SIGNED_IN`, which Supabase emits on every refocus) | No refetch burst or spinner flash when you come back to the tab; polling observers are no longer reset |
| The AI assistant panel's two queries (`aiSessions.list`, then `aiMessages.getContext`) wait until the panel is first opened | 1-2 requests saved on every page load |
| Dashboard no longer fetches `jobs.list` (it was only a loading gate) | 1 request per load, about 15 per minute while open |
| Writes invalidate only what they change for notifications, ideas and the assistant chat (everything else still refreshes everything) | e.g. marking a notification read: about 6 refetches down to 1 |
| Billing page polling while waiting for a payment refreshes only `billing.getStatus`, then one full refresh when the plan changes | about 75 requests per minute down to about 15 |
| Polling follows the data (`src/lib/rpc/polling.ts`): the old rate only while a job, generation or video is in flight or a schedule is about to fire, once a minute otherwise, not at all for settings while auto-publish is off. `staleTime` by data class: 60 s for user, settings, channels, ideas and assistant sessions; 5-10 min for analytics; billing and usage keep 10 s and their old poll rate | an idle focused dashboard: 900 requests an hour down to 180 (150 down to 30 in ten minutes). Measured by a QueryClient simulation on a virtual clock in `polling.test.ts` |

### Server (statements per call, measured with `countQueries`)

| Function | Before | After |
|---|---|---|
| `admin.stats.getStats` (polled every 30 s) | 6 | 1 |
| `admin.billing.overview` (polled by every open admin tab) | 4 | 2 |
| `admin.billing.getPayment` | 2 | 1 |
| `admin.users.getWithDetails` | 5 | 3 |
| `admin.health.getStorageHealth` | 2 | 1 |
| `admin.platformSettings.getStatus` | 2 | 1 |
| `billing.getStatus` (polled every 10 s) | 7 | 4 |
| `consumeQuota` / `getUsage` | 2 / 2 | 1 / 1 |
| `videos.create` | 3 | 2 |
| `queue.getQueueStats` (polled every 5 s) | 2 | 1 |
| `getDashboardStats`, `getChannelTotals` | 2 each | 1 each |
| `getSuggestedTimes` (once 5+ videos are published) | 2 | 1 |
| `aiAssistant.chat` / `metadata.generateForUpload` | 12 / 10 | 9 / 9 |
| Job runner: sweep bookkeeping per tick (8 sweeps) | 18 | 2 |
| Job runner: `recoverStale` when nothing is stuck | 2 | 1 |
| `publish.dueSchedules`, every minute (20 due videos) | 21 | 1 |
| `billing.renewal` sweep, every run after the first | 1 + 3N | 2 |
| Duration backfill ("scan", 30 videos) | 31 | 2 |
| Analytics "Refresh" (50 videos) | 104 | 4 |

`countQueries` does not see `BEGIN`/`COMMIT`, so transaction-heavy paths (the renewal sweep, the due-schedules sweep) saved
more real round trips than the table shows.

Behaviour notes worth knowing:
- Analytics Refresh now meters YouTube quota after the requests (not before each one) and writes the snapshots once at the end
  of the run. A crash in the middle would lose that run's snapshots and undercount that run's quota; the run is bounded to 40 s.
  A failure to record quota is logged instead of failing a video.
- `publish.dueSchedules` picks its batch with a materialised CTE: the old `where id in (select ... limit N for update skip locked)`
  could claim more than N rows (the planner re-ran the subquery per row); the batch size is now exact.
- Job runner: due-ness of sweeps is checked once per tick, so a sweep that becomes due seconds later waits for the next tick.
  It still cannot run twice, and sweeps are still claimed one at a time right before they run (claiming them all up front
  would burn a skipped sweep's interval, up to 6 hours for the daily ingest).

## 3. Not changed: needs your decision

| Item | Impact | Trade-off |
|---|---|---|
| Middleware calls `supabase.auth.getUser()` on every matched request (a network call to Supabase Auth, 0.4-0.7 s). `getClaims()` verifies the JWT locally. | High: one Auth hop per page load, and in production every prefetched `<Link>` (about 13 in the sidebar) | After the change a signed-out/banned/deleted user stays "signed in" for the middleware's redirect decision until their access token expires (the project's JWT expiry). Data access is unaffected: every RPC already uses `getClaims()` and re-reads `isAdmin` and `plan` from the database. Touches `src/middleware.ts`, which is yours. |
| Vercel function region. The database and Auth are in eu-north-1; Vercel defaults to a US region, which would make every statement about 100 ms+ instead of a few ms. | High if wrong; I could not check your project (no access to the team) | None: set the region to `arn1` (Stockholm) in the project settings or `vercel.json`. |
| `DATABASE_POOL_MAX` (see section 1) | Parallel queries in production | Each warm instance holds this many pooler connections. Start with 3. |
| Batch RPC calls from the same tick into one HTTP request (one session check and one `users` read per page load instead of one per RPC) | Medium: a dashboard load is 6 POSTs | A larger change to `/api/rpc`; keeps per-call authorization. |
| Narrow the middleware matcher (landing page, `/sign-in`, `/manifest.json`... still run `getUser`) and avoid the second Auth hop on the landing page | Medium | Do it together with the `getClaims()` change. |
| `ssl: "require"` on the database connection (a plaintext probe connected) | Security, not speed | About one round trip more per cold connect. |

Index suggestions (no migrations were written; each needs a migration on the shared database, so it is your call):
`payment_events (merchant_ref, received_at)`, `payment_events (received_at)`, `payment_orders (created_at)`,
`payment_orders (subscription_id, created_at)`, `subscriptions (status, period_end)`, `tasks (locked_at) where status = 'running'`,
`tasks ((payload->>'videoId')) where status = 'pending'`, `videos (updated_at) where status = 'publishing'`,
`video_analytics (user_id, video_id, day desc)`, `contact_submissions (created_at)`.

## 4. Found, real, not done yet (smaller or riskier)

- Job runner: the drain still issues `claimJobs` and `claimTasks` (two statements) per tick, and both use the
  `id in (select ... limit N for update skip locked)` shape that can claim more than N rows (no double claim is possible). Run
  `EXPLAIN` on production and apply the materialised-CTE rewrite used for `processDueSchedules`. `publish.dueSchedules` has
  `everyMs: 60_000` and cron fires every 60 s, so jitter can make it run every other minute; consider 55 s.
- `runExpirySweep` (billing): per-row downgrade and notice. Batchable, but it moves money state, so it was left alone.
- Weekly digest (per user fan-out), auto-publish batch and `claimAndEnqueuePublish` (a transaction per video, selects
  `captionsVtt` for up to 250 rows), `checkTargets` (one UPDATE per file), OAuth health check (4 statements per channel),
  generation polling and finalize (settings read 3 times), `deleteVideoForUser`, `getContentGaps`, `jobs.create`/`retryJob`,
  `ideas.update`/`linkVideo`, `saveVideoMetadata` (re-reads a row the caller already locked).
- Client: loops of serial writes (mark-ready, generate metadata, schedule) each pay a full refetch round; `videos.listScheduled` duplicates `videos.list`;
  `queue.getQueueStats` duplicates the queue list; the analytics page loads 500 videos only for ten titles; the admin jobs
  page polls both tabs. `videos.get` still polls every 4 s on the detail page (a metadata run handed to the background task leaves
  the video's status unchanged, so nothing in its data says work is running), and the admin billing queries keep their old rate.
- Cold database connections cost 1.0-1.6 s (and any request after 20 s idle pays it on a low-traffic deploy).

## 5. Keeping it fast

- Count, don't guess: `countQueries(() => callRpc(...))` (from `src/server/testing.ts`) returns the number of statements. A test
  that runs a function with 1 row and with N rows and asserts the same count is the N+1 regression guard.
- Prefer one statement over `Promise.all` (production serialises concurrent queries on its one connection). Merge with scalar
  subqueries, `count(*) filter (where ...)`, joins or CTEs. Raw `db.execute` returns timestamps as strings, so use the builder
  when a result has timestamps.
- Never remove `limitConcurrency`, never set `max_pipeline: 0` or `fetch_types: false`.
- React and React DOM must be the same version (a mismatch breaks server rendering in tests and logs errors in dev).
