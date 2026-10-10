/**
 * How often each rpc query refetches while its tab is visible (`refetchInterval`), and how long its data
 * counts as fresh (`staleTime`).
 *
 * There is no server push, so some queries poll. Polling at a fixed 4-30 s whether or not anything is
 * happening cost a focused dashboard about 900 requests an hour, and every request is a Vercel invocation,
 * an auth check, a `users` read and the query itself against a remote database (docs/SCALING-LADDER.md R-3).
 * So the interval is a function of the query's own data:
 *
 *   FAST      something is in flight (a job or generation running, a video queued / generating / publishing)
 *             or about to fire (a scheduled publish, scheduled metadata run or auto-publish due within
 *             DUE_LEAD_MS). Exactly the interval the query had before, so what the user sees while work is
 *             running does not change.
 *   BASELINE  nothing in flight, but the server can still change the data on its own (a scheduled publish
 *             firing, a notification arriving), so look every minute.
 *   NONE      only the user changes this data, and every write already invalidates it (invalidation.ts).
 *   FIXED     money and entitlement data (billing) and anything whose in-flight work is invisible in its own
 *             data: the interval is never relaxed.
 *
 * Polling pauses while the tab is hidden without any code here: TanStack Query only fires the interval when
 * `focusManager.isFocused()`, and `refetchIntervalInBackground` is left at its default (false).
 *
 * Pure module: no React and no TanStack runtime import, so it is unit-testable. Type-only imports tie the
 * field names used below to the server's row types, so renaming a column breaks the build instead of silently
 * switching a rule off.
 */
import type { ApiShape, Doc, ReturnOf } from "./types";

export const MINUTE_MS = 60_000;

/** What providers.tsx gave every query before this module existed. Money paths keep it. */
export const DEFAULT_STALE_MS = 10_000;

/** Poll period when nothing is in flight but the server may still change the data by itself. */
export const BASELINE_MS = MINUTE_MS;

/**
 * A row counts as "about to happen" from this long before its due time. It must be at least BASELINE_MS so a
 * baseline poll always lands inside the window and switches the query to FAST before the due time arrives.
 */
export const DUE_LEAD_MS = 90_000;

/**
 * ...and keeps counting this long after the due time (the minute-by-minute tick plus the work itself). The
 * bound matters: a row left overdue because nothing is running the tick must not pin the tab at FAST forever.
 */
export const DUE_GRACE_MS = 10 * MINUTE_MS;

/** Defaults for every query (providers.tsx). `staleTimeFor` repeats DEFAULT_STALE_MS for unlisted paths. */
export const QUERY_CLIENT_DEFAULTS = {
  queries: { staleTime: DEFAULT_STALE_MS, refetchOnWindowFocus: true },
} as const;

// ─── Data signals ────────────────────────────────────────────────────────────

/** `at` (epoch ms on the wire) is within [now - DUE_GRACE_MS, now + DUE_LEAD_MS]. */
export function isDueSoon(at: unknown, now: number): boolean {
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  return at - now <= DUE_LEAD_MS && now - at <= DUE_GRACE_MS;
}

type VideoRow = Pick<Doc<"videos">, "status" | "scheduledPublishAt" | "metadataScheduledAt">;
type JobRow = Pick<Doc<"jobs">, "status">;
type GenerationRow = Pick<Doc<"generations">, "status">;
type SettingsData = Pick<NonNullable<ReturnOf<ApiShape["settings"]["get"]>>, "autoPublishEnabled" | "autoPublishNextAt">;
type QueueStatsData = Pick<ReturnOf<ApiShape["queue"]["getQueueStats"]>, "nextPublishAt">;
type QueueHealthData = Pick<ReturnOf<ApiShape["admin"]["queue"]["getHealth"]>, "queue" | "tick">;

const VIDEO_IN_FLIGHT: ReadonlySet<VideoRow["status"]> = new Set(["queued", "generating", "publishing"]);
const JOB_IN_FLIGHT: ReadonlySet<JobRow["status"]> = new Set(["pending", "processing"]);
const GENERATION_IN_FLIGHT: ReadonlySet<GenerationRow["status"]> = new Set(["submitted", "processing"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
/** The array a list query returned, or [] for anything else (loading, signed out, unexpected shape). */
const rowsOf = <T>(data: unknown): T[] => (Array.isArray(data) ? (data.filter(isObject) as T[]) : []);

function videoInFlight(v: VideoRow, now: number): boolean {
  if (VIDEO_IN_FLIGHT.has(v.status)) return true;
  // Server-side clocks: the tick turns a due schedule into a publish job, and a due metadata schedule into a task.
  if (v.status === "scheduled") return isDueSoon(v.scheduledPublishAt, now);
  if (v.status === "draft") return isDueSoon(v.metadataScheduledAt, now);
  return false;
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/** ms until the next refetch, or false for none. Gets the query's current data (undefined while loading). */
export type PollRule = (data: unknown, now: number) => number | false;

/** The same period always. */
const fixed =
  (ms: number): PollRule =>
  () =>
    ms;

/** `fastMs` while `isHot(data)`, else BASELINE_MS. Data that is not loaded or not the expected shape is idle. */
const adaptive =
  (fastMs: number, isHot: (data: unknown, now: number) => boolean): PollRule =>
  (data, now) =>
    isHot(data, now) ? fastMs : BASELINE_MS;

const anyVideo = (data: unknown, now: number) => rowsOf<VideoRow>(data).some((v) => videoInFlight(v, now));
const anyJob = (data: unknown) => rowsOf<JobRow>(data).some((j) => JOB_IN_FLIGHT.has(j.status));
const anyGeneration = (data: unknown) => rowsOf<GenerationRow>(data).some((g) => GENERATION_IN_FLIGHT.has(g.status));

/**
 * Admin queue health: work the runner has to do right now, i.e. a job or task that is due-pending or being processed.
 * Work scheduled for later is normal and does not count. Neither does a stale tick: a backlog that nothing is draining
 * must not pin the page at FAST (the same reasoning as DUE_GRACE_MS above); the baseline poll notices when it recovers.
 */
function queueBusy(data: unknown): boolean {
  if (!isObject(data)) return false;
  const d = data as Partial<QueueHealthData>;
  if (d.tick?.stale) return false;
  return [d.queue?.jobs, d.queue?.tasks].some((c) => (c?.pending ?? 0) + (c?.processing ?? 0) > 0);
}

/**
 * path -> rule, for every query that polls. A path that is absent never polls.
 *
 * Who can change each one without the user acting, and so why it polls at all:
 *   jobs / generations   the runner moves pending -> processing -> completed | failed
 *   videos / queue       the tick turns a due schedule into a publish; a job finishing moves the video on
 *   notifications        any job or sweep that finishes or fails adds one
 *   admin lists / stats  other users' activity
 *   admin queue health   the tick, jobs and tasks move on their own (it is the page that says whether they do)
 */
const RULES: ReadonlyMap<string, PollRule> = new Map<string, PollRule>([
  // History page. New rows come from the user (a write refreshes them) or a due schedule (BASELINE catches it).
  ["jobs.list", adaptive(4_000, anyJob)],
  ["generations.listByUser", adaptive(5_000, anyGeneration)],

  // Publish queue: only ready + scheduled videos, so its signal is a scheduled one coming due. A video that is
  // already publishing has left this list. The stats row has no per-video times, only the auto-publish clock.
  ["queue.list", adaptive(5_000, anyVideo)],
  ["queue.getQueueStats", adaptive(5_000, (data, now) => isObject(data) && isDueSoon((data as Partial<QueueStatsData>).nextPublishAt, now))],

  ["videos.list", adaptive(10_000, anyVideo)],
  ["videos.listScheduled", adaptive(15_000, anyVideo)],

  // NEVER RELAXED. A manual metadata regeneration that is handed to the background task ("queued: true" from
  // actions.metadata.generateForUpload) leaves the video's status untouched, so nothing in this row says work is
  // running and the detail page relies on this poll to show the result. Relaxing it needs a server-side flag.
  ["videos.get", fixed(4_000)],

  // The bell has no in-flight signal of its own, so BASELINE. (The video lists switch to FAST while a job runs, so
  // the page the user is watching still updates quickly; the bell dot can trail by up to a minute.)
  ["notifications.get", fixed(BASELINE_MS)],

  // The only server-side writer to `settings` is the auto-publish run (it moves autoPublishNextAt forward), and it
  // only runs while auto-publish is on. Otherwise only the user changes settings and every write invalidates them.
  [
    "settings.get",
    (data, now) => {
      const s = isObject(data) ? (data as Partial<SettingsData>) : undefined;
      if (!s?.autoPublishEnabled) return false;
      return isDueSoon(s.autoPublishNextAt, now) ? 30_000 : BASELINE_MS;
    },
  ],

  // Money: unchanged on purpose (see the billing tests).
  ["billing.getStatus", fixed(10_000)],

  // Admin console. The billing queries are money and keep their period.
  ["admin.jobs.listRecent", adaptive(10_000, anyJob)],
  ["admin.jobs.listFailed", fixed(BASELINE_MS)],
  ["admin.queue.getHealth", adaptive(10_000, queueBusy)],
  ["admin.billing.overview", fixed(30_000)],
  ["admin.billing.listNeedsReview", fixed(30_000)],
  ["admin.stats.getStats", fixed(BASELINE_MS)],
  ["admin.quota.getQuotaOverview", fixed(BASELINE_MS)],
]);

/** ms until `path` should refetch given its current `data`, or false = do not poll. */
export function intervalFor(path: string, data: unknown, now: number = Date.now()): number | false {
  const rule = RULES.get(path);
  if (!rule) return false;
  try {
    return rule(data, now);
  } catch {
    // A rule must never take a page down from inside a render; fall back to the safe slow poll.
    return BASELINE_MS;
  }
}

/** Every path that can poll, for tests and audits. */
export function polledPaths(): string[] {
  return [...RULES.keys()];
}

// ─── staleTime ───────────────────────────────────────────────────────────────

/**
 * How long fetched data stays fresh (no refetch on mount or window focus). A write never waits for this:
 * invalidateQueries marks the query stale whatever its staleTime and refetches it if it is on screen.
 * Money and entitlement paths (billing.*, usageLedger.*, admin.billing.*, admin.usageLedger.*) are deliberately
 * absent: they keep DEFAULT_STALE_MS.
 */
const STALE_MS: ReadonlyMap<string, number> = new Map<string, number>([
  // Change only when the user writes (or a slow sweep runs), and every write invalidates them. users.current
  // carries `plan` and `isAdmin` for display only: the server re-reads both from the database on every call.
  ["users.current", MINUTE_MS],
  ["settings.get", MINUTE_MS],
  ["youtubeChannels.list", MINUTE_MS],
  ["ideas.list", MINUTE_MS],
  ["aiSessions.list", MINUTE_MS],

  // Analytics and insights: derived from YouTube snapshots (a daily ingest or an explicit refresh, which is a
  // write) and from video history.
  ["analytics.getDashboardStats", 5 * MINUTE_MS],
  ["videoAnalytics.listForUser", 5 * MINUTE_MS],
  ["videoAnalytics.getChannelSummary", 5 * MINUTE_MS],
  ["videoAnalytics.getTimeSeriesForUser", 5 * MINUTE_MS],
  ["videoAnalytics.getForVideo", 5 * MINUTE_MS],
  ["scheduling.getSuggestedTimes", 10 * MINUTE_MS],
]);

/** Always a number: `staleTime: undefined` would override the provider default with 0. */
export function staleTimeFor(path: string): number {
  return STALE_MS.get(path) ?? DEFAULT_STALE_MS;
}

/** Every path with a non-default staleTime, for tests and audits. */
export function staleTimePaths(): string[] {
  return [...STALE_MS.keys()];
}

// ─── What useQuery passes to TanStack ────────────────────────────────────────

export type PollingOptions = {
  refetchInterval: false | ((query: { state: { data: unknown } }) => number | false);
  staleTime: number;
};

const OPTIONS = new Map<string, PollingOptions>();

/** The timing options for one rpc path. The same object every call, so options do not churn between renders. */
export function pollingOptions(path: string): PollingOptions {
  let o = OPTIONS.get(path);
  if (!o) {
    o = {
      refetchInterval: RULES.has(path) ? (query) => intervalFor(path, query.state.data) : false,
      staleTime: staleTimeFor(path),
    };
    OPTIONS.set(path, o);
  }
  return o;
}
