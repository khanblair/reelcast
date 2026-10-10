import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { QueryClient, QueryObserver, environmentManager, focusManager, timeoutManager } from "@tanstack/react-query";
import {
  BASELINE_MS,
  DEFAULT_STALE_MS,
  DUE_GRACE_MS,
  DUE_LEAD_MS,
  QUERY_CLIENT_DEFAULTS,
  intervalFor,
  isDueSoon,
  pollingOptions,
  polledPaths,
  staleTimeFor,
  staleTimePaths,
} from "./polling";

// ─── What the server really exports (path "a.b" = modules/a/b.ts or modules/a.ts export b) ───────────

const MODULES_DIR = join(import.meta.dir, "../../server/modules");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
  });
}
const SERVER_KINDS = new Map<string, "query" | "mutation" | "action">();
for (const file of sourceFiles(MODULES_DIR)) {
  const prefix = relative(MODULES_DIR, file).replace(/\.ts$/, "").split("/").join(".");
  for (const m of readFileSync(file, "utf8").matchAll(/^export const (\w+) = (query|mutation|action)\(/gm)) {
    SERVER_KINDS.set(`${prefix}.${m[1]}`, m[2] as "query" | "mutation" | "action");
  }
}
const QUERY_PATHS = [...SERVER_KINDS].filter(([, k]) => k === "query").map(([p]) => p);

// ─── Before: the table and the default this change replaced (frozen copy, do not edit) ───────────────

const LEGACY_LIVE: Record<string, number> = {
  "jobs.list": 4000,
  "generations.listByUser": 5000,
  "queue.list": 5000,
  "queue.getQueueStats": 5000,
  "videos.get": 4000,
  "videos.list": 10000,
  "videos.listScheduled": 15000,
  "notifications.get": 20000,
  "settings.get": 30000,
  "billing.getStatus": 10000,
  "admin.jobs.listRecent": 10000,
  "admin.jobs.listFailed": 15000,
  "admin.billing.overview": 30000,
  "admin.billing.listNeedsReview": 30000,
  "admin.stats.getStats": 30000,
  "admin.quota.getQuotaOverview": 30000,
};
const LEGACY_STALE_MS = 10_000;

// ─── Wire-format fixtures (ids are `_id`, instants are epoch ms, null fields are absent) ─────────────

const NOW = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

const video = (status: string, extra: Record<string, unknown> = {}) => ({
  _id: `v-${status}`,
  _creationTime: NOW - 86_400_000,
  userId: "u1",
  title: "A video",
  rawFileKey: "https://res.cloudinary.com/x/video/upload/a.mp4",
  rawFileSize: 1_000,
  status,
  ...extra,
});
const job = (status: string) => ({ _id: `j-${status}`, userId: "u1", videoId: "v1", type: "publish", status, createdAt: NOW, _creationTime: NOW });
const generation = (status: string) => ({ _id: `g-${status}`, userId: "u1", videoId: "v1", model: "veo", prompt: "p", status, _creationTime: NOW });
/** admin.queue.getHealth as the browser receives it: null fields are absent, only the numbers the rule reads are set. */
type Counts = { pending?: number; scheduled?: number; processing?: number };
const counts = (c: Counts = {}) => ({ pending: 0, scheduled: 0, processing: 0, failedLast24h: 0, ...c });
const queueHealth = (o: { jobs?: Counts; tasks?: Counts; stale?: boolean; heartbeat?: boolean } = {}) => ({
  queue: { jobs: counts(o.jobs), tasks: counts(o.tasks) },
  tick: { stale: o.stale ?? false, ...(o.heartbeat === false ? {} : { lastRunAt: NOW - 30_000, ageMs: 30_000 }) },
  failedTasks: [],
  scheduleErrors: [],
});
const settings = (extra: Record<string, unknown> = {}) => ({ userId: "u1", notificationsEnabled: true, hasResendApiKey: false, hasDeepseekApiKey: false, youtubeConnected: false, ...extra });

const IN_FLIGHT_VIDEO = ["queued", "generating", "publishing"];
const IDLE_VIDEO = ["draft", "ready", "published", "failed"];

// ─── The rules ────────────────────────────────────────────────────────────────────────────────────

describe("the table matches the server", () => {
  test("the scan really found the server surface", () => {
    expect(QUERY_PATHS.length).toBeGreaterThan(40);
    expect(QUERY_PATHS).toContain("videos.list");
    expect(QUERY_PATHS).toContain("admin.jobs.listRecent");
  });

  test("every polled path and every staleTime path is a real query (a typo would silently never apply)", () => {
    for (const p of [...polledPaths(), ...staleTimePaths()]) expect(SERVER_KINDS.get(p)).toBe("query");
  });

  test("everything that polled before still has a rule, and nothing new started polling", () => {
    // LEGACY_LIVE is the frozen "before" table. Paths added since then are listed here on purpose, so a query cannot
    // start polling by accident: admin.queue.getHealth (scaling ladder M-3, the admin job-runner health section).
    const ADDED_SINCE = ["admin.queue.getHealth"];
    expect(polledPaths().sort()).toEqual([...Object.keys(LEGACY_LIVE), ...ADDED_SINCE].sort());
  });

  test("the lead window is at least one baseline period, so a baseline poll always lands inside it", () => {
    expect(DUE_LEAD_MS).toBeGreaterThanOrEqual(BASELINE_MS);
    expect(DUE_GRACE_MS).toBeGreaterThan(0);
  });
});

describe("isDueSoon", () => {
  test("true from DUE_LEAD_MS before the due time until DUE_GRACE_MS after it", () => {
    expect(isDueSoon(NOW + DUE_LEAD_MS, NOW)).toBe(true);
    expect(isDueSoon(NOW + DUE_LEAD_MS + 1, NOW)).toBe(false);
    expect(isDueSoon(NOW, NOW)).toBe(true);
    expect(isDueSoon(NOW - DUE_GRACE_MS, NOW)).toBe(true);
    expect(isDueSoon(NOW - DUE_GRACE_MS - 1, NOW)).toBe(false);
  });

  test("anything that is not a finite number is not due", () => {
    for (const v of [undefined, null, "2026-01-01", NaN, Infinity, {}, []]) expect(isDueSoon(v, NOW)).toBe(false);
  });
});

describe("video lists: fast only while something is in flight or about to fire", () => {
  const LISTS = [
    ["videos.list", 10_000],
    ["videos.listScheduled", 15_000],
    ["queue.list", 5_000],
  ] as const;

  for (const [path, fast] of LISTS) {
    describe(path, () => {
      test("polls at today's rate while a video is queued, generating or publishing", () => {
        for (const status of IN_FLIGHT_VIDEO) expect(intervalFor(path, [video("ready"), video(status)], NOW)).toBe(fast);
      });

      test("polls at the baseline when nothing is in flight", () => {
        expect(intervalFor(path, IDLE_VIDEO.map((s) => video(s)), NOW)).toBe(BASELINE_MS);
      });

      test("baseline, never fast, for data that is loading, empty, signed out or not a list", () => {
        for (const data of [undefined, null, [], {}, "x", 7, [null], [undefined], [1, "a"]]) expect(intervalFor(path, data, NOW)).toBe(BASELINE_MS);
      });

      test("a scheduled video far in the future does not speed the poll up", () => {
        expect(intervalFor(path, [video("scheduled", { scheduledPublishAt: NOW + 6 * 3_600_000 })], NOW)).toBe(BASELINE_MS);
      });

      test("a scheduled video about to come due, or just overdue, does", () => {
        for (const offset of [DUE_LEAD_MS, 30 * SEC, 0, -45 * SEC, -DUE_GRACE_MS]) {
          expect(intervalFor(path, [video("scheduled", { scheduledPublishAt: NOW + offset })], NOW)).toBe(fast);
        }
      });

      test("a scheduled video that stays overdue (nothing running the tick) stops pinning the tab at fast", () => {
        expect(intervalFor(path, [video("scheduled", { scheduledPublishAt: NOW - DUE_GRACE_MS - 1 })], NOW)).toBe(BASELINE_MS);
      });

      test("a draft whose AI metadata run is about to fire does, an old schedule on a ready video does not", () => {
        expect(intervalFor(path, [video("draft", { metadataScheduledAt: NOW + 20 * SEC })], NOW)).toBe(fast);
        expect(intervalFor(path, [video("draft", { metadataScheduledAt: NOW + 3_600_000 })], NOW)).toBe(BASELINE_MS);
        expect(intervalFor(path, [video("ready", { metadataScheduledAt: NOW + 20 * SEC })], NOW)).toBe(BASELINE_MS);
        expect(intervalFor(path, [video("published", { scheduledPublishAt: NOW - 20 * SEC })], NOW)).toBe(BASELINE_MS);
      });

      test("one busy video among many idle ones is enough", () => {
        const many = Array.from({ length: 200 }, (_, i) => video("published", { _id: `p${i}` }));
        expect(intervalFor(path, [...many, video("generating")], NOW)).toBe(fast);
        expect(intervalFor(path, many, NOW)).toBe(BASELINE_MS);
      });
    });
  }

  test("videos.get is never relaxed: a background metadata run is invisible in its data", () => {
    for (const data of [undefined, null, video("published"), video("draft"), video("generating"), { ...video("ready"), metadataHistory: [] }]) {
      expect(intervalFor("videos.get", data, NOW)).toBe(4_000);
    }
  });
});

describe("jobs and generations", () => {
  test("jobs.list: fast while a job is pending or processing, baseline once all are finished", () => {
    expect(intervalFor("jobs.list", [job("completed"), job("pending")], NOW)).toBe(4_000);
    expect(intervalFor("jobs.list", [job("processing")], NOW)).toBe(4_000);
    expect(intervalFor("jobs.list", [job("completed"), job("failed")], NOW)).toBe(BASELINE_MS);
    expect(intervalFor("jobs.list", [], NOW)).toBe(BASELINE_MS);
    expect(intervalFor("jobs.list", undefined, NOW)).toBe(BASELINE_MS);
  });

  test("generations.listByUser: fast while a Veo generation is submitted or processing", () => {
    expect(intervalFor("generations.listByUser", [generation("submitted")], NOW)).toBe(5_000);
    expect(intervalFor("generations.listByUser", [generation("completed"), generation("processing")], NOW)).toBe(5_000);
    expect(intervalFor("generations.listByUser", [generation("completed"), generation("failed")], NOW)).toBe(BASELINE_MS);
    expect(intervalFor("generations.listByUser", [], NOW)).toBe(BASELINE_MS);
  });

  test("admin.jobs.listRecent follows the same rule at its own rate; listFailed has nothing in flight to see", () => {
    expect(intervalFor("admin.jobs.listRecent", [job("pending")], NOW)).toBe(10_000);
    expect(intervalFor("admin.jobs.listRecent", [job("completed")], NOW)).toBe(BASELINE_MS);
    expect(intervalFor("admin.jobs.listFailed", [job("failed")], NOW)).toBe(BASELINE_MS);
    expect(intervalFor("admin.jobs.listFailed", [], NOW)).toBe(BASELINE_MS);
  });
});

describe("queue stats, notifications, settings, admin aggregates", () => {
  test("queue.getQueueStats is fast only when the auto-publish clock is about to fire", () => {
    expect(intervalFor("queue.getQueueStats", { readyCount: 3, scheduledCount: 2, nextPublishAt: NOW + 30 * SEC }, NOW)).toBe(5_000);
    expect(intervalFor("queue.getQueueStats", { readyCount: 3, scheduledCount: 2, nextPublishAt: NOW + 3_600_000 }, NOW)).toBe(BASELINE_MS);
    expect(intervalFor("queue.getQueueStats", { readyCount: 0, scheduledCount: 0 }, NOW)).toBe(BASELINE_MS);
    expect(intervalFor("queue.getQueueStats", undefined, NOW)).toBe(BASELINE_MS);
  });

  test("notifications.get checks once a minute whatever it holds", () => {
    for (const data of [undefined, [], [{ _id: "n", isRead: false }]]) expect(intervalFor("notifications.get", data, NOW)).toBe(BASELINE_MS);
  });

  test("settings.get does not poll while auto-publish is off: only the user changes it", () => {
    for (const data of [undefined, null, settings(), settings({ autoPublishEnabled: false, autoPublishNextAt: NOW + SEC })]) {
      expect(intervalFor("settings.get", data, NOW)).toBe(false);
    }
  });

  test("settings.get follows autoPublishNextAt while auto-publish is on (the run moves it forward server-side)", () => {
    expect(intervalFor("settings.get", settings({ autoPublishEnabled: true }), NOW)).toBe(BASELINE_MS);
    expect(intervalFor("settings.get", settings({ autoPublishEnabled: true, autoPublishNextAt: NOW + 6 * 3_600_000 }), NOW)).toBe(BASELINE_MS);
    expect(intervalFor("settings.get", settings({ autoPublishEnabled: true, autoPublishNextAt: NOW + 45 * SEC }), NOW)).toBe(30_000);
    expect(intervalFor("settings.get", settings({ autoPublishEnabled: true, autoPublishNextAt: NOW - 2 * MIN }), NOW)).toBe(30_000);
  });

  test("admin stats and quota overview: baseline", () => {
    for (const path of ["admin.stats.getStats", "admin.quota.getQuotaOverview"]) {
      for (const data of [undefined, {}, []]) expect(intervalFor(path, data, NOW)).toBe(BASELINE_MS);
    }
  });
});

describe("admin queue health", () => {
  const PATH = "admin.queue.getHealth";

  test("fast while a job or task is due or being processed", () => {
    for (const o of [{ jobs: { pending: 1 } }, { jobs: { processing: 1 } }, { tasks: { pending: 3 } }, { tasks: { processing: 1 } }, { jobs: { pending: 2 }, tasks: { processing: 2 } }]) {
      expect(intervalFor(PATH, queueHealth(o), NOW)).toBe(10_000);
    }
  });

  test("baseline when nothing is due or running, however much is scheduled for later or has failed", () => {
    expect(intervalFor(PATH, queueHealth(), NOW)).toBe(BASELINE_MS);
    expect(intervalFor(PATH, queueHealth({ jobs: { scheduled: 40 }, tasks: { scheduled: 9 } }), NOW)).toBe(BASELINE_MS);
    const failed = queueHealth();
    failed.queue.tasks.failedLast24h = 12;
    failed.failedTasks = [{ kind: "x" }] as never[];
    expect(intervalFor(PATH, failed, NOW)).toBe(BASELINE_MS);
  });

  test("a stale tick does not pin the page at fast: a backlog nothing is draining stays at the baseline", () => {
    expect(intervalFor(PATH, queueHealth({ jobs: { pending: 5 }, stale: true }), NOW)).toBe(BASELINE_MS);
    expect(intervalFor(PATH, queueHealth({ tasks: { processing: 1 }, stale: true }), NOW)).toBe(BASELINE_MS);
  });

  test("no heartbeat recorded (normal in dev) is not a stale tick: work still polls fast", () => {
    expect(intervalFor(PATH, queueHealth({ jobs: { pending: 1 }, heartbeat: false }), NOW)).toBe(10_000);
  });

  test("it always polls, and loading or unexpected data is the baseline, never fast and never off", () => {
    for (const data of [undefined, null, {}, [], "x", 7, { queue: null }, { queue: {} }, { queue: { jobs: null, tasks: [] }, tick: null }]) {
      expect(intervalFor(PATH, data, NOW)).toBe(BASELINE_MS);
    }
    expect(pollingOptions(PATH).refetchInterval).toBeInstanceOf(Function);
  });
});

describe("queries only the user changes do not poll", () => {
  test("no rule for them, and the options say so", () => {
    for (const path of ["ideas.list", "users.current", "aiSessions.list", "aiMessages.getContext", "youtubeChannels.list", "analytics.getDashboardStats", "videoAnalytics.listForUser", "scheduling.getSuggestedTimes"]) {
      expect(intervalFor(path, [video("generating")], NOW)).toBe(false);
      expect(pollingOptions(path).refetchInterval).toBe(false);
    }
  });

  test("Object.prototype names are not rules", () => {
    for (const path of ["constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
      expect(intervalFor(path, [video("generating")], NOW)).toBe(false);
      expect(staleTimeFor(path)).toBe(DEFAULT_STALE_MS);
    }
  });
});

describe("billing and entitlement data is untouched", () => {
  test("billing.getStatus polls every 10 s whatever the data says", () => {
    for (const data of [undefined, null, { plan: "free", subscription: null }, { plan: "pro", subscription: { status: "approval_pending" } }]) {
      expect(intervalFor("billing.getStatus", data, NOW)).toBe(10_000);
    }
  });

  test("admin billing polls at its old 30 s", () => {
    for (const path of ["admin.billing.overview", "admin.billing.listNeedsReview"]) {
      for (const data of [undefined, [], { needsReviewCount: 4 }]) expect(intervalFor(path, data, NOW)).toBe(30_000);
    }
  });

  test("their intervals equal the old table's", () => {
    for (const path of ["billing.getStatus", "admin.billing.overview", "admin.billing.listNeedsReview"]) {
      expect(intervalFor(path, undefined, NOW)).toBe(LEGACY_LIVE[path]);
    }
  });

  test("every billing / usage / plan query keeps the old 10 s staleTime", () => {
    const money = QUERY_PATHS.filter((p) => /^(admin\.)?(billing|usageLedger)\./.test(p));
    expect(money).toContain("billing.getStatus");
    expect(money).toContain("usageLedger.getUsageSummary");
    expect(money).toContain("admin.billing.overview");
    expect(money).toContain("admin.usageLedger.getOverview");
    for (const p of money) {
      expect(staleTimeFor(p)).toBe(LEGACY_STALE_MS);
      expect(staleTimePaths()).not.toContain(p);
    }
  });
});

describe("staleTime by class of data", () => {
  test("data only the user changes stays fresh for at least a minute", () => {
    for (const p of ["users.current", "settings.get", "youtubeChannels.list", "ideas.list", "aiSessions.list"]) {
      expect(staleTimeFor(p)).toBeGreaterThanOrEqual(60_000);
    }
  });

  test("analytics and insights stay fresh for 5-10 minutes", () => {
    for (const p of ["analytics.getDashboardStats", "videoAnalytics.listForUser", "videoAnalytics.getChannelSummary", "videoAnalytics.getTimeSeriesForUser", "videoAnalytics.getForVideo", "scheduling.getSuggestedTimes"]) {
      expect(staleTimeFor(p)).toBeGreaterThanOrEqual(5 * MIN);
      expect(staleTimeFor(p)).toBeLessThanOrEqual(10 * MIN);
    }
  });

  test("live data and unlisted paths keep the old default, as a number (undefined would mean 0)", () => {
    for (const p of ["videos.list", "videos.get", "notifications.get", "queue.list", "jobs.list", "billing.getStatus", "some.unknownPath"]) {
      expect(staleTimeFor(p)).toBe(LEGACY_STALE_MS);
    }
    for (const p of QUERY_PATHS) {
      expect(Number.isFinite(staleTimeFor(p))).toBe(true);
      expect(staleTimeFor(p)).toBeGreaterThanOrEqual(DEFAULT_STALE_MS);
    }
  });

  test("the client default matches DEFAULT_STALE_MS and still refetches on focus", () => {
    expect(QUERY_CLIENT_DEFAULTS.queries.staleTime).toBe(DEFAULT_STALE_MS);
    expect(QUERY_CLIENT_DEFAULTS.queries.refetchOnWindowFocus).toBe(true);
  });
});

describe("pollingOptions (what useQuery hands to TanStack)", () => {
  test("a stable object per path, with a real staleTime for every path", () => {
    for (const p of [...QUERY_PATHS, "nope"]) {
      expect(pollingOptions(p)).toBe(pollingOptions(p));
      expect(pollingOptions(p).staleTime).toBe(staleTimeFor(p));
    }
  });

  test("the interval is a function of the query's data, read when TanStack asks for it", () => {
    const o = pollingOptions("videos.list");
    expect(typeof o.refetchInterval).toBe("function");
    const ask = (data: unknown) => (o.refetchInterval as (q: { state: { data: unknown } }) => number | false)({ state: { data } });
    expect(ask([video("generating")])).toBe(10_000);
    expect(ask([video("ready")])).toBe(BASELINE_MS);
    expect(ask(undefined)).toBe(BASELINE_MS);
  });

  test("client.ts passes them to useQuery and no longer has a fixed table", () => {
    const src = readFileSync(join(import.meta.dir, "client.ts"), "utf8");
    expect(src).toContain("...pollingOptions(path)");
    expect(src).not.toMatch(/\bLIVE\b/);
    expect(src).not.toMatch(/^\s*refetchInterval:/m);
    expect(src).not.toMatch(/^\s*staleTime:/m);
  });

  test("providers.tsx takes the client defaults from the same module", () => {
    const src = readFileSync(join(import.meta.dir, "../../components/providers.tsx"), "utf8");
    expect(src).toContain("QUERY_CLIENT_DEFAULTS");
    expect(src).not.toMatch(/staleTime:\s*10_?000/);
  });
});

// ─── A real QueryClient on a virtual clock ───────────────────────────────────────────────────────────

type Timer = { id: number; at: number; cb: () => void; every?: number };

/** Manual clock behind TanStack's timeoutManager and Date.now, so ten (or sixty) minutes run in milliseconds. */
class VirtualTime {
  readonly start = NOW;
  elapsed = 0;
  private seq = 0;
  private timers = new Map<number, Timer>();

  now() {
    return this.start + this.elapsed;
  }

  private add(cb: () => void, ms: number, every?: number) {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.elapsed + Math.max(0, ms), cb, every });
    return id;
  }

  readonly provider = {
    setTimeout: (cb: () => void, ms: number) => this.add(cb, ms),
    setInterval: (cb: () => void, ms: number) => this.add(cb, ms, ms),
    clearTimeout: (id: number) => void this.timers.delete(Number(id)),
    clearInterval: (id: number) => void this.timers.delete(Number(id)),
  };

  async advance(ms: number) {
    await settle(); // a fetch started since the last call must finish before its timers are read
    const end = this.elapsed + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers.values()) {
        if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) break;
      this.elapsed = next.at;
      if (next.every) next.at += next.every;
      else this.timers.delete(next.id);
      next.cb();
      await settle();
    }
    this.elapsed = end;
    await settle();
  }
}

/** Let the fake queryFn promises and TanStack's own microtasks finish. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

type Mode = "before" | "after";

/** Options exactly as useQuery builds them: BEFORE = the old table and default, AFTER = pollingOptions(path). */
function optionsFor(mode: Mode, path: string) {
  return mode === "after"
    ? pollingOptions(path)
    : { refetchInterval: LEGACY_LIVE[path] ?? (false as const), staleTime: LEGACY_STALE_MS };
}

class Sim {
  readonly time = new VirtualTime();
  readonly qc = new QueryClient({ defaultOptions: QUERY_CLIENT_DEFAULTS });
  readonly server = new Map<string, unknown>();
  /** Every request, with the virtual time it was made at. */
  readonly requests: { path: string; at: number; data: unknown }[] = [];
  private offs: (() => void)[] = [];

  constructor() {
    this.qc.mount();
  }

  observe(path: string, mode: Mode) {
    const obs = new QueryObserver(this.qc, {
      queryKey: ["rpc", path, {}],
      queryFn: async () => {
        const data = this.server.get(path);
        this.requests.push({ path, at: this.time.elapsed, data });
        return data ?? null;
      },
      ...optionsFor(mode, path),
    });
    this.offs.push(obs.subscribe(() => {}));
    return obs;
  }

  /** Polls of `path` (requests after the initial load) made in the window (from, to]. */
  polls(path: string, from = 0, to = Infinity) {
    return this.requests.filter((r) => r.path === path && r.at > 0 && r.at > from && r.at <= to).length;
  }

  /** Polls (everything after the initial load) across paths. */
  allPolls(paths: string[]) {
    return paths.reduce((n, p) => n + this.polls(p), 0);
  }

  times(path: string) {
    return this.requests.filter((r) => r.path === path).map((r) => r.at);
  }

  dispose() {
    for (const off of this.offs) off();
    this.qc.unmount();
    this.qc.clear();
  }
}

const realProvider = {
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  clearInterval: (id: unknown) => clearInterval(id as ReturnType<typeof setInterval>),
};
const realNow = Date.now;

/** TanStack wants one provider for the whole run, so install a single proxy and point it at each test's clock. */
let currentTime: VirtualTime | undefined;
const proxyProvider = {
  setTimeout: (cb: () => void, ms: number) => currentTime!.provider.setTimeout(cb, ms),
  clearTimeout: (id: number | undefined) => currentTime?.provider.clearTimeout(Number(id)),
  setInterval: (cb: () => void, ms: number) => currentTime!.provider.setInterval(cb, ms),
  clearInterval: (id: number | undefined) => currentTime?.provider.clearInterval(Number(id)),
};

beforeAll(() => {
  timeoutManager.setTimeoutProvider(proxyProvider);
  // bun has no `window`, and TanStack then treats the process as a server and never schedules refetch timers.
  environmentManager.setIsServer(() => false);
});
afterAll(() => {
  // Switching providers after use makes TanStack print a development warning; this is a test-only restore.
  const err = console.error;
  console.error = () => {};
  try {
    timeoutManager.setTimeoutProvider(realProvider);
  } finally {
    console.error = err;
  }
  environmentManager.setIsServer(() => typeof window === "undefined");
  Date.now = realNow;
});

/** Run the body on a fresh client and virtual clock, and always put the real clock back. */
async function withSim(body: (sim: Sim) => Promise<void>) {
  const sim = new Sim();
  currentTime = sim.time;
  Date.now = () => sim.time.now();
  focusManager.setFocused(true);
  try {
    await body(sim);
  } finally {
    sim.dispose();
    focusManager.setFocused(undefined);
    Date.now = realNow;
    currentTime = undefined;
  }
}

const DASHBOARD = ["videos.list", "videos.listScheduled", "notifications.get", "settings.get"];

function idleDashboard(sim: Sim) {
  sim.server.set("videos.list", [video("published"), video("ready"), video("draft")]);
  sim.server.set("videos.listScheduled", [video("published", { scheduledPublishAt: NOW - 3_600_000 })]);
  sim.server.set("notifications.get", []);
  sim.server.set("settings.get", settings({ autoPublishEnabled: false }));
}

describe("simulation: an idle, focused dashboard", () => {
  test("requests in 10 minutes and per hour, before and after", async () => {
    const result = {} as Record<Mode, { tenMin: number; perHour: number; perPath: Record<string, number> }>;

    for (const mode of ["before", "after"] as const) {
      await withSim(async (sim) => {
        idleDashboard(sim);
        for (const p of DASHBOARD) sim.observe(p, mode);
        await sim.time.advance(10 * MIN);
        const tenMin = sim.allPolls(DASHBOARD);
        await sim.time.advance(50 * MIN);
        const perPath = Object.fromEntries(DASHBOARD.map((p) => [p, sim.polls(p)]));
        result[mode] = { tenMin, perHour: sim.allPolls(DASHBOARD), perPath };
      });
    }

    if (process.env.POLLING_REPORT) console.log("idle focused dashboard", JSON.stringify(result));

    // Before: 10 s, 15 s, 20 s, 30 s intervals = 6+4+3+2 polls a minute.
    expect(result.before.perPath).toEqual({ "videos.list": 360, "videos.listScheduled": 240, "notifications.get": 180, "settings.get": 120 });
    expect(result.before.tenMin).toBe(150);
    expect(result.before.perHour).toBe(900);

    // After: three queries once a minute, settings.get not at all (auto-publish is off).
    expect(result.after.perPath).toEqual({ "videos.list": 60, "videos.listScheduled": 60, "notifications.get": 60, "settings.get": 0 });
    expect(result.after.tenMin).toBe(30);
    expect(result.after.perHour).toBe(180);
  });

  test("with auto-publish on, settings.get polls once a minute", async () => {
    await withSim(async (sim) => {
      idleDashboard(sim);
      sim.server.set("settings.get", settings({ autoPublishEnabled: true, autoPublishNextAt: NOW + 6 * 3_600_000 }));
      sim.observe("settings.get", "after");
      await sim.time.advance(60 * MIN);
      expect(sim.polls("settings.get")).toBe(60);
    });
  });
});

describe("simulation: in-flight work refreshes as fast as before", () => {
  const BUSY: [string, unknown][] = [
    ["videos.list", [video("generating")]],
    ["videos.listScheduled", [video("publishing", { scheduledPublishAt: NOW - 30 * SEC })]],
    ["queue.list", [video("scheduled", { scheduledPublishAt: NOW + 20 * SEC })]],
    ["jobs.list", [job("processing")]],
    ["generations.listByUser", [generation("processing")]],
    ["admin.jobs.listRecent", [job("pending")]],
  ];

  for (const [path, data] of BUSY) {
    test(`${path}: same number of requests over 10 minutes`, async () => {
      const counts: number[] = [];
      for (const mode of ["before", "after"] as const) {
        await withSim(async (sim) => {
          sim.server.set(path, data);
          sim.observe(path, mode);
          await sim.time.advance(4 * MIN);
          counts.push(sim.polls(path));
        });
      }
      expect(counts[1]).toBe(counts[0]);
      expect(counts[0]).toBeGreaterThan(10);
    });
  }

  test("a job finishing: still seen within one fast period, then the poll relaxes", async () => {
    await withSim(async (sim) => {
      sim.server.set("videos.list", [video("generating")]);
      sim.observe("videos.list", "after");
      await sim.time.advance(120 * SEC);
      expect(sim.polls("videos.list", 0, 120 * SEC)).toBe(12); // every 10 s while generating

      sim.server.set("videos.list", [video("ready")]); // the job completes at t = 120 s
      await sim.time.advance(10 * SEC);
      const seenAt = sim.requests.find((r) => r.at > 120 * SEC && (r.data as { status: string }[])[0].status === "ready")!.at;
      expect(seenAt - 120 * SEC).toBeLessThanOrEqual(10 * SEC);

      await sim.time.advance(10 * MIN);
      expect(sim.polls("videos.list", seenAt, seenAt + 10 * MIN)).toBeLessThanOrEqual(10); // now once a minute
    });
  });

  test("work that starts on its own is noticed within a baseline period, then polled fast", async () => {
    await withSim(async (sim) => {
      sim.server.set("videos.list", [video("ready")]);
      sim.observe("videos.list", "after");
      await sim.time.advance(200 * SEC);

      sim.server.set("videos.list", [video("publishing")]); // e.g. the auto-publish run claims the video
      await sim.time.advance(2 * MIN);
      const seenAt = sim.requests.find((r) => r.at > 200 * SEC && (r.data as { status: string }[])[0].status === "publishing")!.at;
      expect(seenAt - 200 * SEC).toBeLessThanOrEqual(BASELINE_MS);
      // ...and from then on every 10 s.
      expect(sim.polls("videos.list", seenAt, seenAt + 60 * SEC)).toBe(6);
    });
  });
});

describe("simulation: admin queue health", () => {
  const PATH = "admin.queue.getHealth";

  test("every 10 s while work is due, once a minute when idle, and it relaxes when the queue drains", async () => {
    await withSim(async (sim) => {
      sim.server.set(PATH, queueHealth({ jobs: { pending: 1 } }));
      sim.observe(PATH, "after");
      await sim.time.advance(60 * SEC);
      expect(sim.polls(PATH, 0, 60 * SEC)).toBe(6);

      sim.server.set(PATH, queueHealth()); // drained
      await sim.time.advance(10 * SEC); // the next fast poll sees it
      const idleFrom = sim.time.elapsed;
      await sim.time.advance(10 * MIN);
      expect(sim.polls(PATH, idleFrom, idleFrom + 10 * MIN)).toBeLessThanOrEqual(10);
      expect(sim.polls(PATH, idleFrom, idleFrom + 10 * MIN)).toBeGreaterThanOrEqual(9);
    });
  });
});

describe("simulation: a scheduled publish still shows up promptly", () => {
  // Every phase of the poll cycle relative to the due time, because a poll can land anywhere in the window.
  for (const phase of [0, 7, 19, 31, 44, 58]) {
    test(`phase ${phase}s: the flip to publishing is seen within one fast period of the tick`, async () => {
      const due = 5 * MIN + phase * SEC;
      const ticked = due + 25 * SEC; // the minute-by-minute tick turns the schedule into a publish a little later
      const latencies: Record<Mode, number> = { before: 0, after: 0 };
      for (const mode of ["before", "after"] as const) {
        await withSim(async (sim) => {
          sim.server.set("videos.list", [video("scheduled", { scheduledPublishAt: NOW + due })]);
          sim.observe("videos.list", mode);
          await sim.time.advance(ticked);
          sim.server.set("videos.list", [video("publishing")]);
          await sim.time.advance(2 * MIN);
          const seen = sim.requests.find((r) => r.at >= ticked && (r.data as { status: string }[])[0].status === "publishing");
          latencies[mode] = seen!.at - ticked;
        });
      }
      expect(latencies.before).toBeLessThanOrEqual(10 * SEC);
      expect(latencies.after).toBeLessThanOrEqual(10 * SEC);
    });
  }

  test("far from the due time it polls once a minute, near it every 10 s", async () => {
    await withSim(async (sim) => {
      sim.server.set("videos.list", [video("scheduled", { scheduledPublishAt: NOW + 30 * MIN })]);
      sim.observe("videos.list", "after");
      await sim.time.advance(10 * MIN);
      expect(sim.polls("videos.list")).toBe(10);
      await sim.time.advance(19 * MIN); // t = 29 min, due at 30: this poll is inside the lead window
      const before = sim.polls("videos.list");
      await sim.time.advance(60 * SEC);
      expect(sim.polls("videos.list") - before).toBe(6);
    });
  });
});

describe("simulation: hidden tabs", () => {
  test("nothing polls while the tab is hidden, before or after", async () => {
    for (const mode of ["before", "after"] as const) {
      await withSim(async (sim) => {
        sim.server.set("videos.list", [video("generating")]);
        sim.server.set("jobs.list", [job("processing")]);
        sim.observe("videos.list", mode);
        sim.observe("jobs.list", mode);
        await sim.time.advance(30 * SEC);
        const seen = sim.requests.length;
        focusManager.setFocused(false);
        await sim.time.advance(10 * MIN);
        expect(sim.requests.length).toBe(seen);
      });
    }
  });

  test("coming back refetches what is stale, and leaves long-lived data alone", async () => {
    await withSim(async (sim) => {
      sim.server.set("videos.list", [video("ready")]);
      sim.server.set("ideas.list", []);
      sim.server.set("analytics.getDashboardStats", { totalVideos: 1 });
      for (const p of ["videos.list", "ideas.list", "analytics.getDashboardStats"]) sim.observe(p, "after");
      await sim.time.advance(5 * SEC);

      focusManager.setFocused(false);
      await sim.time.advance(30 * SEC); // away for half a minute
      focusManager.setFocused(true);
      await sim.time.advance(SEC);
      expect(sim.polls("videos.list")).toBe(1); // 10 s staleTime: refetched
      expect(sim.polls("ideas.list")).toBe(0); // 60 s staleTime: still fresh
      expect(sim.polls("analytics.getDashboardStats")).toBe(0);

      focusManager.setFocused(false);
      await sim.time.advance(6 * MIN); // away for six minutes
      focusManager.setFocused(true);
      await sim.time.advance(SEC);
      expect(sim.polls("ideas.list")).toBe(1);
      expect(sim.polls("analytics.getDashboardStats")).toBe(1);
    });
  });
});
