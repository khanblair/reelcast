/**
 * fetchSnapshotsForUser: equivalence with the original per-video implementation, and a statement-count guard.
 *
 * `legacyFetchSnapshots` below is the ORIGINAL implementation (a quota upsert and a snapshot upsert per video, a
 * separate channel / rows / count read), kept as the reference. Each scenario runs the legacy code for one user and
 * the new code for an identical twin user, against the same mocked YouTube Analytics API, and compares the returned
 * runs, the stored `video_analytics` rows, the recorded quota units and the requests sent. No test touches the network.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videoAnalytics, videos, youtubeChannels } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { badRequest, notFound } from "@/server/rpc/errors";
import { countQueries, inRolledBackTx } from "@/server/testing";
import { loadYoutubeDeps } from "./deps";
import {
  MAX_VIDEOS_PER_FETCH,
  fetchSnapshotsForUser,
  markChannelOAuthStatus,
  metricsFromRecord,
  upsertSnapshot,
  type SnapshotDeps,
  type SnapshotResult,
  type SnapshotRun,
} from "./snapshots";
import { SNAPSHOT_METRICS, YtAnalyticsError, addDays, rowToRecord, runReport, utcDay } from "./ytReports";

setDefaultTimeout(240_000);

// ─── the original implementation (reference) ─────────────────────────────────

const LEGACY_AUTH_MESSAGE = "YouTube authorization expired. Reconnect your YouTube account.";

async function legacyFetchSnapshots(
  deps: SnapshotDeps,
  userId: string,
  opts: { videoId?: string; maxVideos?: number; budgetMs?: number } = {},
): Promise<SnapshotRun> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const maxVideos = opts.maxVideos ?? MAX_VIDEOS_PER_FETCH;
  const deadline = Date.now() + (opts.budgetMs ?? 40_000);

  const [channel] = await db
    .select({ id: youtubeChannels.id })
    .from(youtubeChannels)
    .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.isPrimary, true)))
    .limit(1);
  if (!channel) throw badRequest("YouTube account is not connected");

  let rows: { id: string; publishedVideoId: string | null; publishedAt: Date | null }[];
  let total: number;
  if (opts.videoId) {
    rows = await db
      .select({ id: videos.id, publishedVideoId: videos.publishedVideoId, publishedAt: videos.publishedAt })
      .from(videos)
      .where(and(eq(videos.id, opts.videoId), eq(videos.userId, userId)))
      .limit(1);
    if (!rows[0]) throw notFound("Video not found");
    if (!rows[0].publishedVideoId) throw badRequest("Video has not been published to YouTube yet");
    total = 1;
  } else {
    const where = and(eq(videos.userId, userId), eq(videos.status, "published"), isNotNull(videos.publishedVideoId));
    rows = await db
      .select({ id: videos.id, publishedVideoId: videos.publishedVideoId, publishedAt: videos.publishedAt })
      .from(videos)
      .where(where)
      .orderBy(sql`${videos.publishedAt} desc nulls last`, desc(videos.createdAt))
      .limit(maxVideos);
    const [{ n }] = await db.select({ n: count() }).from(videos).where(where);
    total = Number(n);
  }

  let token: { accessToken: string; channelId: string };
  try {
    token = await deps.getToken(channel.id);
  } catch {
    throw badRequest(LEGACY_AUTH_MESSAGE);
  }

  const endDate = utcDay(now());
  const results: SnapshotResult[] = [];
  let authFailed = false;

  const one = async (v: (typeof rows)[number]): Promise<SnapshotResult> => {
    const youtubeVideoId = v.publishedVideoId!;
    const start = v.publishedAt ?? addDays(now(), -30);
    const startDate = utcDay(start) > endDate ? endDate : utcDay(start);
    try {
      await deps.addQuota(userId, 1);
      const table = await runReport(token.accessToken, {
        channelId: token.channelId,
        startDate,
        endDate,
        metrics: SNAPSHOT_METRICS,
        videoIds: [youtubeVideoId],
      });
      if (table.rows.length === 0) return { videoId: v.id, ok: true, data: null };
      const metrics = metricsFromRecord(rowToRecord(table.headers, table.rows[0]));
      const fetchedAt = now();
      await upsertSnapshot(db, { userId, videoId: v.id, youtubeVideoId, fetchedAt, ...metrics });
      return { videoId: v.id, ok: true, data: { userId, videoId: v.id, youtubeVideoId, fetchedAt, ...metrics } };
    } catch (e) {
      if (e instanceof YtAnalyticsError) {
        if (e.kind === "auth") {
          authFailed = true;
          return { videoId: v.id, ok: false, error: LEGACY_AUTH_MESSAGE };
        }
        if (e.kind === "forbidden") {
          return { videoId: v.id, ok: false, error: "YouTube Analytics access is not granted for this channel (reconnect YouTube and allow analytics access)." };
        }
        return { videoId: v.id, ok: false, error: e.message };
      }
      console.error("[analytics] snapshot failed", { videoId: v.id, error: e instanceof Error ? e.message : String(e) });
      return { videoId: v.id, ok: false, error: "Failed to fetch analytics" };
    }
  };

  for (let i = 0; i < rows.length && !authFailed; i += 5) {
    if (i > 0 && Date.now() > deadline) break;
    results.push(...(await Promise.all(rows.slice(i, i + 5).map(one))));
  }

  if (authFailed) {
    await markChannelOAuthStatus(db, channel.id, "token_expired");
    throw badRequest(LEGACY_AUTH_MESSAGE);
  }

  return { results, total, processed: results.length, truncated: results.length < total };
}

// ─── mocked YouTube Analytics API ────────────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const FULL = ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "subscribersGained"];
type Behaviour =
  | { kind: "ok"; values: (number | string | null)[]; headers?: string[] }
  | { kind: "empty" }
  | { kind: "status"; status: number }
  | { kind: "network" };
const ok = (values: (number | string | null)[], headers?: string[]): Behaviour => ({ kind: "ok", values, headers });
const std = (i: number) => ok([100 + i, 10 + i / 2, 30 + i / 4, i, i + 1, i + 2]);

/** Answers each single-video report by its `video==<id>` filter. `calls` records "<id>|<startDate>|<endDate>". */
function mockApi(behaviours: Record<string, Behaviour>, fallback: Behaviour = ok([1, 1, 1, 1, 1, 1])) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    const id = u.searchParams.get("filters")!.replace("video==", "");
    calls.push(`${id}|${u.searchParams.get("startDate")}|${u.searchParams.get("endDate")}`);
    const b = behaviours[id] ?? fallback;
    if (b.kind === "network") throw new TypeError("fetch failed");
    if (b.kind === "status") return new Response("nope", { status: b.status });
    if (b.kind === "empty") return Response.json({ columnHeaders: FULL.map((name) => ({ name })), rows: [] });
    return Response.json({ columnHeaders: (b.headers ?? FULL).map((name) => ({ name })), rows: [b.values] });
  }) as unknown as typeof fetch;
  return calls;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-09T10:00:00Z");
const DAY = "2026-10-09";
const PREV_DAY = "2026-10-08";
const OLD = new Date("2026-10-09T01:00:00Z");

type VSpec = { label: string } & Partial<typeof videos.$inferInsert>;

/** Published videos `labels`, newest first (publishedAt strictly decreasing), each with youtube id `yt-<label>`. */
function published(labels: string[]): VSpec[] {
  return labels.map((label, i) => ({ label, publishedAt: new Date(Date.UTC(2026, 8, 20 - i)) }));
}

async function mkChannel(tx: DbLike, userId: string, over: Partial<typeof youtubeChannels.$inferInsert> = {}) {
  const [c] = await tx
    .insert(youtubeChannels)
    .values({ userId, channelId: `UC-${randomUUID()}`, accessToken: encryptSecret("live-token"), tokenExpiry: new Date(Date.now() + 3_600_000), oauthStatus: "connected", isPrimary: true, ...over })
    .returning();
  return c;
}

async function mkVideos(tx: DbLike, userId: string, specs: VSpec[]) {
  const rows = await tx
    .insert(videos)
    .values(
      specs.map(({ label, ...over }) => ({
        userId,
        title: `snap-${label}`,
        rawFileKey: "k",
        rawFileSize: 1,
        status: "published" as const,
        publishedVideoId: `yt-${label}`,
        ...over,
      })),
    )
    .returning({ id: videos.id, title: videos.title });
  const idOf: Record<string, string> = {};
  const labelOf = new Map<string, string>();
  for (const r of rows) {
    const label = r.title.replace("snap-", "");
    idOf[label] = r.id;
    labelOf.set(r.id, label);
  }
  return { idOf, labelOf };
}

type Seeded = Awaited<ReturnType<typeof mkVideos>> & { channelId: string };

async function seedUser(tx: DbLike, userId: string, specs: VSpec[]): Promise<Seeded> {
  const channel = await mkChannel(tx, userId);
  return { ...(await mkVideos(tx, userId, specs)), channelId: channel.id };
}

/** Deps with a recording quota function and a fixed clock. */
function mkDeps(db: DbLike, over: Partial<SnapshotDeps> = {}) {
  const quota: number[] = [];
  const tokenCalls: string[] = [];
  const deps: SnapshotDeps = {
    db,
    getToken: async (id) => (tokenCalls.push(id), { accessToken: "tok", channelId: "UC-TEST" }),
    addQuota: async (_u, units) => void quota.push(units),
    now: () => NOW,
    ...over,
  };
  return { deps, quota, tokenCalls };
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

type Seed = Awaited<ReturnType<typeof mkVideos>>;

/** The run, with ids replaced by labels so the two users' runs can be compared. */
function normRun(run: SnapshotRun, seed: Seed) {
  const label = (id: string) => seed.labelOf.get(id) ?? id;
  return {
    total: run.total,
    processed: run.processed,
    truncated: run.truncated,
    results: run.results.map((r) => ({
      video: label(r.videoId),
      ok: r.ok,
      error: r.error,
      data: r.data === undefined ? undefined : r.data === null ? null : { ...r.data, userId: "<user>", videoId: label(String(r.data.videoId)) },
    })),
  };
}

/** Every stored snapshot row for the user's videos (whoever owns the row), by video label, minus surrogate keys. */
async function storedRows(tx: DbLike, seed: Seed, owners: Record<string, string>) {
  const rows = await tx.select().from(videoAnalytics).where(inArray(videoAnalytics.videoId, Object.values(seed.idOf)));
  return rows
    .map((r) => ({ ...r, id: undefined, videoId: undefined, userId: undefined, video: seed.labelOf.get(r.videoId)!, owner: owners[r.userId] ?? "?" }))
    .sort((a, b) => (a.video + a.day).localeCompare(b.video + b.day));
}

async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: T } | { err: { code: unknown; message: string } }> {
  try {
    return { ok: await fn() };
  } catch (e) {
    return { err: { code: (e as { code?: unknown }).code, message: (e as Error).message } };
  }
}

// ─── equivalence ─────────────────────────────────────────────────────────────

const EQ_LABELS = ["v00", "v01", "v02", "v03", "v04", "v05", "v06", "v07", "v08", "v09", "v10", "v11", "v12"];
function eqSpecs(): VSpec[] {
  const specs = published(EQ_LABELS);
  const byLabel = (l: string) => specs.find((s) => s.label === l)!;
  byLabel("v10").publishedAt = null; // window falls back to 30 days back
  byLabel("v11").publishedAt = new Date("2026-11-01T00:00:00Z"); // in the future: start is clamped to the end date
  return [
    ...specs,
    { label: "draft", status: "draft", publishedVideoId: null, publishedAt: null },
    { label: "pubNoId", publishedVideoId: null, publishedAt: new Date("2026-09-30T00:00:00Z") },
    { label: "sched", status: "scheduled", publishedAt: new Date("2026-09-30T00:00:00Z") },
  ];
}
const eqBehaviours = (pass: 1 | 2): Record<string, Behaviour> => ({
  "yt-v00": pass === 1 ? std(0) : ok([200, 20, 40, 20, 30, 3]),
  "yt-v01": pass === 1 ? ok([555, 66], ["views", "likes"]) : ok([9], ["comments"]),
  "yt-v02": ok([null, "n/a", 40, null, 5, "x"]), // only the two numeric values are "provided"
  "yt-v03": { kind: "empty" },
  "yt-v04": { kind: "status", status: 403 },
  "yt-v05": { kind: "status", status: 500 },
  "yt-v06": { kind: "status", status: 400 },
  "yt-v07": { kind: "network" },
  "yt-v08": pass === 1 ? ok([3_000_000_000, 0, 12.34, -5, 10.6, 0]) : { kind: "status", status: 500 },
  "yt-v09": std(9),
  "yt-v10": std(10),
  "yt-v11": std(11),
  "yt-v12": std(12),
});

async function preseed(tx: DbLike, userId: string, strangerId: string, seed: Seed) {
  const base = (label: string, over: Partial<typeof videoAnalytics.$inferInsert>) => ({
    userId,
    videoId: seed.idOf[label],
    youtubeVideoId: "yt-old",
    day: DAY,
    fetchedAt: OLD,
    ...over,
  });
  await tx.insert(videoAnalytics).values([
    base("v00", { views: 1, watchTimeMinutes: 4.5, avgViewDurationSec: 6, likes: 2, comments: 3, subscribersGained: 7, impressions: 100, ctr: 0.5, estimatedRevenue: 9 }),
    base("v01", { views: 11, watchTimeMinutes: 12.5, avgViewDurationSec: 13, likes: 14, comments: 15, subscribersGained: 16, impressions: 200 }),
    base("v02", { views: 21, watchTimeMinutes: 22.5, avgViewDurationSec: 23, likes: 24, comments: 25, subscribersGained: 26 }),
    base("v03", { views: 31 }),
    base("v12", { day: PREV_DAY, views: 5 }), // an older day: must stay as it is
    base("v09", { userId: strangerId, views: 777, likes: 7 }), // somebody else's row in this video's (video, day) slot
  ]);
}

describe("fetchSnapshotsForUser equivalence with the per-video implementation", () => {
  test("same results, same stored rows (only returned metrics overwrite), same requests and quota units, twice in a row", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const legacyUser = await makeUser();
      const strangerNew = await makeUser();
      const strangerOld = await makeUser();
      const a = await seedUser(tx, user.id, eqSpecs());
      const b = await seedUser(tx, legacyUser.id, eqSpecs());
      await preseed(tx, user.id, strangerNew.id, a);
      await preseed(tx, legacyUser.id, strangerOld.id, b);
      const ownersA = { [user.id]: "me", [strangerNew.id]: "stranger" };
      const ownersB = { [legacyUser.id]: "me", [strangerOld.id]: "stranger" };

      for (const pass of [1, 2] as const) {
        const calls = mockApi(eqBehaviours(pass));
        const newD = mkDeps(tx);
        const oldD = mkDeps(tx);
        const got = await fetchSnapshotsForUser(newD.deps, user.id);
        const callsNew = calls.splice(0);
        const want = await legacyFetchSnapshots(oldD.deps, legacyUser.id);
        const callsOld = calls.splice(0);

        expect(normRun(got, a)).toEqual(normRun(want, b));
        expect(got.total).toBe(13); // drafts, rows without a YouTube id and scheduled rows are not counted
        expect(got.truncated).toBe(false);
        expect([...callsNew].sort()).toEqual([...callsOld].sort()); // same requests, same date windows
        expect(callsNew).toHaveLength(13);
        expect(callsNew).toContain("yt-v10|2026-09-09|2026-10-09"); // unknown publish date: 30 days back
        expect(callsNew).toContain("yt-v11|2026-10-09|2026-10-09"); // future publish date: clamped
        expect(sum(newD.quota)).toBe(sum(oldD.quota)); // identical units...
        expect(sum(newD.quota)).toBe(13);
        expect(oldD.quota).toEqual(Array(13).fill(1));
        expect(newD.quota).toEqual([13]); // ...recorded once
        expect(newD.tokenCalls).toEqual([a.channelId]);

        const rowsA = await storedRows(tx, a, ownersA);
        expect(rowsA).toEqual(await storedRows(tx, b, ownersB));

        const row = (label: string, day = DAY, owner = "me") => rowsA.find((r) => r.video === label && r.day === day && r.owner === owner)!;
        if (pass === 1) {
          expect(row("v00")).toMatchObject({ youtubeVideoId: "yt-v00", views: 100, watchTimeMinutes: 10, avgViewDurationSec: 30, likes: 0, comments: 1, subscribersGained: 2, impressions: 100, ctr: 0.5, estimatedRevenue: 9 });
          expect(row("v00").fetchedAt).toEqual(NOW);
          // only the two returned metrics change; everything else keeps its stored value
          expect(row("v01")).toMatchObject({ views: 555, likes: 66, watchTimeMinutes: 12.5, avgViewDurationSec: 13, comments: 15, subscribersGained: 16, impressions: 200 });
          expect(row("v02")).toMatchObject({ views: 21, watchTimeMinutes: 22.5, avgViewDurationSec: 40, likes: 24, comments: 5, subscribersGained: 26 });
          expect(row("v03")).toMatchObject({ views: 31, youtubeVideoId: "yt-old" }); // empty report: not touched
          expect(row("v03").fetchedAt).toEqual(OLD);
          expect(row("v08")).toMatchObject({ views: 2_147_483_647, watchTimeMinutes: 0, avgViewDurationSec: 12.34, likes: 0, comments: 11, subscribersGained: 0, impressions: null, ctr: null });
          expect(row("v09", DAY, "stranger")).toMatchObject({ views: 777, likes: 7, youtubeVideoId: "yt-old" }); // not ours: left alone
          expect(rowsA.some((r) => r.video === "v09" && r.owner === "me")).toBe(false);
          expect(row("v10")).toMatchObject({ views: 110 });
          expect(row("v11")).toMatchObject({ views: 111 });
          expect(row("v12", PREV_DAY)).toMatchObject({ views: 5, youtubeVideoId: "yt-old" });
          expect(row("v12")).toMatchObject({ views: 112 });
          for (const l of ["v04", "v05", "v06", "v07"]) expect(rowsA.some((r) => r.video === l)).toBe(false); // failed reports store nothing
        } else {
          expect(row("v00")).toMatchObject({ views: 200, watchTimeMinutes: 20, avgViewDurationSec: 40, likes: 20, comments: 30, subscribersGained: 3, impressions: 100 });
          expect(row("v01")).toMatchObject({ views: 555, likes: 66, comments: 9 }); // views/likes from pass 1 survive, comments updated
          expect(row("v08")).toMatchObject({ views: 2_147_483_647 }); // pass 2 failed for it: the first values stay
        }
      }
    });
  });

  test("a rejected token (401) mid-run: earlier batches and the rest of the failing batch are stored, later batches never start, all requests are metered, the channel is marked", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const legacyUser = await makeUser();
      const labels = Array.from({ length: 12 }, (_, i) => `v${String(i).padStart(2, "0")}`);
      const a = await seedUser(tx, user.id, published(labels));
      const b = await seedUser(tx, legacyUser.id, published(labels));
      const calls = mockApi({ "yt-v06": { kind: "status", status: 401 } }, std(1));

      const newD = mkDeps(tx);
      const oldD = mkDeps(tx);
      const got = await outcome(() => fetchSnapshotsForUser(newD.deps, user.id));
      const callsNew = calls.splice(0);
      const want = await outcome(() => legacyFetchSnapshots(oldD.deps, legacyUser.id));
      const callsOld = calls.splice(0);

      expect(got).toEqual(want);
      expect(got).toEqual({ err: { code: "BAD_REQUEST", message: LEGACY_AUTH_MESSAGE } });
      expect([...callsNew].sort()).toEqual([...callsOld].sort());
      expect(callsNew).toHaveLength(10); // batches of 5: the third batch never starts
      expect(sum(newD.quota)).toBe(10);
      expect(sum(oldD.quota)).toBe(10);

      const rowsA = await storedRows(tx, a, { [user.id]: "me" });
      expect(rowsA).toEqual(await storedRows(tx, b, { [legacyUser.id]: "me" }));
      expect(rowsA.map((r) => r.video)).toEqual(["v00", "v01", "v02", "v03", "v04", "v05", "v07", "v08", "v09"]);

      const status = async (id: string) => (await tx.select({ s: youtubeChannels.oauthStatus }).from(youtubeChannels).where(eq(youtubeChannels.id, id)))[0].s;
      expect(await status(a.channelId)).toBe("token_expired");
      expect(await status(b.channelId)).toBe("token_expired");
    });
  });

  test("the time budget stops new batches: same partial run, only issued requests are metered", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const legacyUser = await makeUser();
      const labels = Array.from({ length: 12 }, (_, i) => `v${String(i).padStart(2, "0")}`);
      const a = await seedUser(tx, user.id, published(labels));
      const b = await seedUser(tx, legacyUser.id, published(labels));
      const calls = mockApi({}, std(2));
      const newD = mkDeps(tx);
      const oldD = mkDeps(tx);
      const got = await fetchSnapshotsForUser(newD.deps, user.id, { budgetMs: -1 });
      const callsNew = calls.splice(0);
      const want = await legacyFetchSnapshots(oldD.deps, legacyUser.id, { budgetMs: -1 });
      expect(normRun(got, a)).toEqual(normRun(want, b));
      expect(got).toMatchObject({ total: 12, processed: 5, truncated: true });
      expect(callsNew).toHaveLength(5);
      expect(sum(newD.quota)).toBe(5);
      expect(sum(oldD.quota)).toBe(5);
      expect(await storedRows(tx, a, { [user.id]: "me" })).toEqual(await storedRows(tx, b, { [legacyUser.id]: "me" }));
    });
  });

  test("single video, missing channel, ownership, no videos, token failure, maxVideos: same outcomes and error order as the original", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const legacyUser = await makeUser();
      const noChannelNew = await makeUser();
      const noChannelOld = await makeUser();
      const stranger = await makeUser();
      const labels = ["v0", "v1", "v2", "v3"];
      const specs = [...published(labels), { label: "draft", status: "draft" as const, publishedVideoId: null, publishedAt: null }];
      const a = await seedUser(tx, user.id, specs);
      const b = await seedUser(tx, legacyUser.id, specs);
      const ncA = await mkVideos(tx, noChannelNew.id, published(["n0"]));
      const ncB = await mkVideos(tx, noChannelOld.id, published(["n0"]));
      const foreign = await mkVideos(tx, stranger.id, published(["f0"]));
      const empty = await makeUser(); // channel but nothing published
      const emptyOld = await makeUser();
      await mkChannel(tx, empty.id);
      await mkChannel(tx, emptyOld.id);
      mockApi({}, std(3));

      type Case = { name: string; newRun: (d: SnapshotDeps) => Promise<SnapshotRun>; oldRun: (d: SnapshotDeps) => Promise<SnapshotRun>; seedNew: Seed; seedOld: Seed };
      const mk = (name: string, uidNew: string, uidOld: string, seedNew: Seed, seedOld: Seed, opts: (s: Seed) => Parameters<typeof fetchSnapshotsForUser>[2] = () => ({})): Case => ({
        name,
        newRun: (d) => fetchSnapshotsForUser(d, uidNew, opts(seedNew)),
        oldRun: (d) => legacyFetchSnapshots(d, uidOld, opts(seedOld)),
        seedNew,
        seedOld,
      });
      const cases: Case[] = [
        mk("no channel", noChannelNew.id, noChannelOld.id, ncA, ncB),
        mk("no channel and an unknown video: the channel error wins", noChannelNew.id, noChannelOld.id, ncA, ncB, () => ({ videoId: randomUUID() })),
        mk("unknown video id", user.id, legacyUser.id, a, b, () => ({ videoId: "00000000-0000-4000-8000-000000000000" })),
        mk("somebody else's video", user.id, legacyUser.id, a, b, () => ({ videoId: foreign.idOf.f0 })),
        mk("not published yet", user.id, legacyUser.id, a, b, (s) => ({ videoId: s.idOf.draft })),
        mk("one video", user.id, legacyUser.id, a, b, (s) => ({ videoId: s.idOf.v2 })),
        mk("maxVideos 2 of 4", user.id, legacyUser.id, a, b, () => ({ maxVideos: 2 })),
        mk("maxVideos 0", user.id, legacyUser.id, a, b, () => ({ maxVideos: 0 })),
        mk("nothing published", empty.id, emptyOld.id, { idOf: {}, labelOf: new Map() }, { idOf: {}, labelOf: new Map() }),
      ];
      for (const c of cases) {
        const newD = mkDeps(tx);
        const oldD = mkDeps(tx);
        const got = await outcome(async () => normRun(await c.newRun(newD.deps), c.seedNew));
        const want = await outcome(async () => normRun(await c.oldRun(oldD.deps), c.seedOld));
        expect({ case: c.name, ...got }).toEqual({ case: c.name, ...want });
        expect({ case: c.name, units: sum(newD.quota) }).toEqual({ case: c.name, units: sum(oldD.quota) });
      }

      // spot-check the interesting outcomes explicitly
      const run = async (c: Case) => outcome(async () => normRun(await c.newRun(mkDeps(tx).deps), c.seedNew));
      expect(await run(cases[0])).toEqual({ err: { code: "BAD_REQUEST", message: "YouTube account is not connected" } });
      expect(await run(cases[1])).toEqual({ err: { code: "BAD_REQUEST", message: "YouTube account is not connected" } });
      expect(await run(cases[2])).toEqual({ err: { code: "NOT_FOUND", message: "Video not found" } });
      expect(await run(cases[3])).toEqual({ err: { code: "NOT_FOUND", message: "Video not found" } });
      expect(await run(cases[4])).toEqual({ err: { code: "BAD_REQUEST", message: "Video has not been published to YouTube yet" } });
      expect(await run(cases[6])).toMatchObject({ ok: { total: 4, processed: 2, truncated: true } });
      expect(await run(cases[7])).toMatchObject({ ok: { total: 4, processed: 0, truncated: true, results: [] } });
      const nothing = await outcome(() => cases[8].newRun(mkDeps(tx).deps));
      expect(nothing).toEqual({ ok: { results: [], total: 0, processed: 0, truncated: false } });

      // A token failure is reported even when there is nothing to fetch, before any request or quota use.
      const failing = (uid: string, fn: typeof fetchSnapshotsForUser | typeof legacyFetchSnapshots) => {
        const d = mkDeps(tx, { getToken: async () => { throw new Error("revoked"); } });
        return outcome(() => fn(d.deps, uid)).then((o) => ({ o, units: sum(d.quota) }));
      };
      expect(await failing(user.id, fetchSnapshotsForUser)).toEqual(await failing(legacyUser.id, legacyFetchSnapshots));
      expect(await failing(empty.id, fetchSnapshotsForUser)).toEqual({ o: { err: { code: "BAD_REQUEST", message: LEGACY_AUTH_MESSAGE } }, units: 0 });
    });
  });

  test("a failing snapshot write only fails its own video (like the original); the others are stored", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const legacyUser = await makeUser();
      const labels = ["v0", "v1", "v2", "v3", "v4", "v5"];
      const a = await seedUser(tx, user.id, published(labels));
      const b = await seedUser(tx, legacyUser.id, published(labels));
      mockApi({}, std(4));

      // A database whose snapshot insert is rejected whenever it carries the poisoned video (as a foreign-key
      // violation would for a video deleted mid-refresh). A real failing statement would abort the test transaction.
      const poisoned = (db: DbLike): DbLike =>
        new Proxy(db, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target);
            if (prop !== "insert") return typeof value === "function" ? value.bind(target) : value;
            return (table: unknown) => {
              const builder = (value as (t: unknown) => { values: (v: unknown) => unknown }).call(target, table);
              if (table !== videoAnalytics) return builder;
              return {
                values: (v: unknown) => {
                  const hit = (Array.isArray(v) ? v : [v]).some((r) => (r as { youtubeVideoId?: string }).youtubeVideoId === "yt-v2");
                  return hit ? { onConflictDoUpdate: () => Promise.reject(new Error("insert or update violates foreign key constraint")) } : builder.values(v);
                },
              };
            };
          },
        });

      const errors: unknown[][] = [];
      const savedError = console.error;
      console.error = (...args: unknown[]) => void errors.push(args);
      try {
        const newD = mkDeps(poisoned(tx));
        const oldD = mkDeps(poisoned(tx));
        const got = await fetchSnapshotsForUser(newD.deps, user.id);
        const logsNew = errors.splice(0).filter((e) => e[0] === "[analytics] snapshot failed");
        const want = await legacyFetchSnapshots(oldD.deps, legacyUser.id);
        const logsOld = errors.splice(0).filter((e) => e[0] === "[analytics] snapshot failed");

        expect(normRun(got, a)).toEqual(normRun(want, b));
        expect(got.results.map((r) => r.ok)).toEqual([true, true, false, true, true, true]);
        expect(got.results[2]).toEqual({ videoId: a.idOf.v2, ok: false, error: "Failed to fetch analytics" });
        const label = (e: unknown[], seed: Seed) => ({ ...(e[1] as { videoId: string; error: string }), videoId: seed.labelOf.get((e[1] as { videoId: string }).videoId) });
        expect(logsNew.map((e) => label(e, a))).toEqual(logsOld.map((e) => label(e, b)));
        expect(logsNew).toHaveLength(1);
        expect(sum(newD.quota)).toBe(6);
        const rowsA = await storedRows(tx, a, { [user.id]: "me" });
        expect(rowsA).toEqual(await storedRows(tx, b, { [legacyUser.id]: "me" }));
        expect(rowsA.map((r) => r.video)).toEqual(["v0", "v1", "v3", "v4", "v5"]);
      } finally {
        console.error = savedError;
      }
    });
  });

  test("if recording the quota fails the fetched snapshots are still stored and returned (the failure is logged)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const a = await seedUser(tx, user.id, published(["v0", "v1", "v2"]));
      mockApi({}, std(5));
      const errors: unknown[][] = [];
      const savedError = console.error;
      console.error = (...args: unknown[]) => void errors.push(args);
      try {
        const d = mkDeps(tx, { addQuota: async () => { throw new Error("quota table unavailable"); } });
        const run = await fetchSnapshotsForUser(d.deps, user.id);
        expect(run.results.every((r) => r.ok)).toBe(true);
        expect((await storedRows(tx, a, { [user.id]: "me" })).map((r) => r.video)).toEqual(["v0", "v1", "v2"]);
        expect(errors.some((e) => String(e[0]).includes("quota"))).toBe(true);
      } finally {
        console.error = savedError;
      }
    });
  });
});

// ─── statement count ─────────────────────────────────────────────────────────

describe("fetchSnapshotsForUser statement count (YouTube HTTP is mocked and not counted)", () => {
  test("is the same for 2, 10 and 50 videos, with the real token and quota helpers", async () => {
    await inRolledBackTx(async ({ tx, makeUser }) => {
      const counts: Record<number, number> = {};
      let statements: string[] = [];
      for (const n of [2, 10, 50]) {
        const u = await makeUser();
        const labels = Array.from({ length: n }, (_, i) => `v${String(i).padStart(2, "0")}`);
        const seed = await seedUser(tx, u.id, published(labels));
        mockApi({}, std(n));
        const deps = await loadYoutubeDeps(tx);
        const { result, queries, statements: stmts } = await countQueries(() => fetchSnapshotsForUser({ db: tx, ...deps, now: () => NOW }, u.id));
        counts[n] = queries;
        if (n === 10) statements = stmts;
        expect(result).toMatchObject({ total: n, processed: n, truncated: false });
        expect(result.results.every((r) => r.ok)).toBe(true);
        // every snapshot was stored and the whole run was metered
        expect((await storedRows(tx, seed, { [u.id]: "me" })).length).toBe(n);
        const [q] = (await tx.execute(sql`select units_used from youtube_quota_usage where user_id = ${u.id}`)) as unknown as { units_used: number }[];
        expect(Number(q.units_used)).toBe(n);
      }
      console.log("[snapshot statement counts by videos]", JSON.stringify(counts));
      console.log("[snapshot statements, 10 videos]\n" + statements.map((s) => "  " + s.replace(/\s+/g, " ").slice(0, 110)).join("\n"));
      expect(counts[10]).toBe(counts[2]);
      expect(counts[50]).toBe(counts[2]);
      expect(counts[2]).toBe(4); // rows (+ count + channel), token re-read, quota, one multi-row upsert
    });
  });
});
