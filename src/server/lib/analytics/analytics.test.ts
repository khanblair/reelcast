/**
 * Analytics tests: snapshot upserts, SQL aggregates, time series, purge, daily ingest (with a
 * mocked YouTube Analytics API: no real network), the 6-hourly sweep, and the PostHog helper.
 * DB work runs inside a rolled-back transaction.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { tasks, videoAnalytics, videoDailyStats, videos, youtubeChannels } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { dailyIngestSweep, handlers as analyticsHandlers, INGEST_KIND, runIngestChunk } from "@/server/jobs/handlers/analytics";
import { taskHandlers, sweeps } from "@/server/jobs/handlers";
import { callRpc, inRolledBackTx } from "@/server/testing";
import type { UserRow } from "@/server/rpc/define";
import {
  INGEST_QUOTA_CEILING,
  dailyRowsFromTable,
  ingestUserDailyStats,
  selectIngestUsers,
  type IngestDeps,
} from "./dailyIngest";
import { captureServerEvent, sanitizeProps } from "./posthog";
import { purgeUserAnalytics } from "./purge";
import { dayRange } from "./queries";
import { upsertSnapshot } from "./snapshots";
import { YtAnalyticsError, addDays, runReport, utcDay } from "./ytReports";

setDefaultTimeout(120_000);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function mockFetch(handler: Handler) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HEADERS = ["video", "day", "views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "subscribersGained", "subscribersLost"].map((name) => ({ name }));
const DAY_HEADERS = HEADERS.filter((h) => h.name !== "video");

async function mkVideo(tx: DbLike, userId: string, over: Partial<typeof videos.$inferInsert> = {}) {
  const [v] = await tx
    .insert(videos)
    .values({ userId, title: "v", rawFileKey: "k", rawFileSize: 1, status: "published", publishedVideoId: `yt-${randomUUID().slice(0, 8)}`, publishedAt: new Date(Date.now() - 30 * 86_400_000), ...over })
    .returning();
  return v;
}

/** Other agents' committed test rows may exist for the shared test user: start from a clean slate (rolled back). */
async function clean(tx: DbLike, userId: string) {
  await tx.execute(sql`
    with a as (delete from video_analytics where user_id = ${userId}),
         b as (delete from video_daily_stats where user_id = ${userId})
    delete from youtube_channels where user_id = ${userId}
  `);
}

const today = () => new Date();
const dayAgo = (n: number) => utcDay(addDays(today(), -n));

// ─── snapshots ───────────────────────────────────────────────────────────────

describe("video_analytics snapshots", () => {
  test("upsert is idempotent per (video, UTC day) and only overwrites provided metrics", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      const v = await mkVideo(tx, user.id);
      const at = new Date("2026-10-09T08:00:00Z");
      const base = { userId: user.id, videoId: v.id, youtubeVideoId: v.publishedVideoId! };

      await upsertSnapshot(tx, { ...base, fetchedAt: at, views: 10, likes: 5, watchTimeMinutes: 1.5 });
      await upsertSnapshot(tx, { ...base, fetchedAt: new Date("2026-10-09T20:00:00Z"), views: 25, comments: 2 });

      const rows = await tx.select().from(videoAnalytics).where(sql`video_id = ${v.id}`);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ day: "2026-10-09", views: 25, likes: 5, comments: 2, watchTimeMinutes: 1.5 });
      expect(rows[0].fetchedAt.toISOString()).toBe("2026-10-09T20:00:00.000Z");
      // never fabricated
      expect(rows[0].impressions).toBeNull();
      expect(rows[0].ctr).toBeNull();

      // next UTC day = a new row
      await upsertSnapshot(tx, { ...base, fetchedAt: new Date("2026-10-10T00:00:01Z"), views: 40 });
      expect((await tx.select().from(videoAnalytics).where(sql`video_id = ${v.id}`)).length).toBe(2);
    });
  });

  test("concurrent-style double upsert in one statement window leaves one row", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      const v = await mkVideo(tx, user.id);
      const base = { userId: user.id, videoId: v.id, youtubeVideoId: v.publishedVideoId!, fetchedAt: new Date("2026-10-09T01:00:00Z") };
      await Promise.all([upsertSnapshot(tx, { ...base, views: 1 }), upsertSnapshot(tx, { ...base, views: 2 })]);
      expect((await tx.select().from(videoAnalytics).where(sql`video_id = ${v.id}`)).length).toBe(1);
    });
  });
});

describe("videoAnalytics queries (SQL aggregates)", () => {
  test("latest snapshot per video, sums, avg CTR only when real, owner scoping", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      const v1 = await mkVideo(tx, user.id);
      const v2 = await mkVideo(tx, user.id);
      const mk = (v: { id: string; publishedVideoId: string | null }, day: string, over: Partial<typeof videoAnalytics.$inferInsert>) =>
        ({ userId: user.id, videoId: v.id, youtubeVideoId: v.publishedVideoId!, day, ...over });
      await tx.insert(videoAnalytics).values([
        mk(v1, dayAgo(2), { views: 100, watchTimeMinutes: 10, likes: 4, comments: 1, fetchedAt: addDays(today(), -2) }),
        mk(v1, dayAgo(1), { views: 150, watchTimeMinutes: 20, likes: 6, comments: 2, fetchedAt: addDays(today(), -1) }),
        mk(v2, dayAgo(1), { views: 50, watchTimeMinutes: 5, likes: 1, comments: 0, fetchedAt: addDays(today(), -0.5) }),
      ]);

      type Summary = { totalViews: number; totalWatchTimeMinutes: number; totalImpressions: number; avgCtr?: number; topVideos: { videoId: string; views: number }[] };
      const s = (await callRpc("videoAnalytics.getChannelSummary", {}, { user, tx })) as Summary;
      expect(s.totalViews).toBe(200); // 150 (latest of v1) + 50, not 300
      expect(s.totalWatchTimeMinutes).toBe(25);
      expect(s.totalImpressions).toBe(0);
      expect("avgCtr" in s).toBe(false); // no CTR data => key omitted, UI hides it
      expect(s.topVideos.map((t) => t.videoId)).toEqual([v1.id, v2.id]);
      expect(s.topVideos[0].views).toBe(150);

      const list = (await callRpc("videoAnalytics.listForUser", {}, { user, tx })) as { videoId: string; views: number; fetchedAt: number }[];
      expect(list.length).toBe(2);
      expect(list.map((r) => r.videoId)).toEqual([v2.id, v1.id]); // most recently fetched first
      expect(list.find((r) => r.videoId === v1.id)!.views).toBe(150);
      expect(((await callRpc("videoAnalytics.listForUser", { limit: 1 }, { user, tx })) as unknown[]).length).toBe(1);

      const one = (await callRpc("videoAnalytics.getForVideo", { videoId: v1.id }, { user, tx })) as { views: number; fetchedAt: number; day: string };
      expect(one.views).toBe(150);
      expect(one.day).toBe(dayAgo(1));
      expect(typeof one.fetchedAt).toBe("number");

      // another account cannot read it (Convex had no ownership check)
      const stranger: UserRow = { ...user, id: randomUUID() };
      expect(await callRpc("videoAnalytics.getForVideo", { videoId: v1.id }, { user: stranger, tx })).toBeNull();
      expect(await callRpc("videoAnalytics.listForUser", {}, { user: stranger, tx })).toEqual([]);

      // real CTR data => average over the videos that have it
      await tx.update(videoAnalytics).set({ ctr: 0.02, impressions: 1000 }).where(sql`video_id = ${v1.id} and day = ${dayAgo(1)}`);
      await tx.update(videoAnalytics).set({ ctr: 0.04, impressions: 500 }).where(sql`video_id = ${v2.id}`);
      const s2 = (await callRpc("videoAnalytics.getChannelSummary", {}, { user, tx })) as Summary;
      expect(s2.avgCtr).toBeCloseTo(0.03, 10);
      expect(s2.totalImpressions).toBe(1500);
    });
  });

  test("time series prefers daily stats and falls back to carried-forward snapshots", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      type Series = { source: string; days: number; points: { day: string; views: number }[] };
      const get = () => callRpc("videoAnalytics.getTimeSeriesForUser", { days: 7 }, { user, tx }) as Promise<Series>;

      expect((await get()).source).toBe("none");

      const v1 = await mkVideo(tx, user.id);
      const v2 = await mkVideo(tx, user.id);
      const snap = (v: typeof v1, ago: number, views: number) => ({ userId: user.id, videoId: v.id, youtubeVideoId: v.publishedVideoId!, day: dayAgo(ago), views });
      await tx.insert(videoAnalytics).values([snap(v1, 3, 10), snap(v2, 2, 5), snap(v1, 1, 30)]);

      const fb = await get();
      expect(fb.source).toBe("snapshots");
      // starts at the first snapshot, cumulative, carried forward per video
      expect(fb.points.map((p) => [p.day, p.views])).toEqual([
        [dayAgo(3), 10],
        [dayAgo(2), 15],
        [dayAgo(1), 35],
        [dayAgo(0), 35],
      ]);

      await tx.insert(videoDailyStats).values([
        { videoId: v1.id, userId: user.id, day: dayAgo(2), views: 7 },
        { videoId: v2.id, userId: user.id, day: dayAgo(2), views: 3 },
        { videoId: v1.id, userId: user.id, day: dayAgo(0), views: 4 },
      ]);
      const daily = await get();
      expect(daily.source).toBe("daily");
      expect(daily.points.length).toBe(7);
      expect(daily.points.map((p) => p.day)).toEqual(dayRange(7));
      expect(daily.points.find((p) => p.day === dayAgo(2))!.views).toBe(10);
      expect(daily.points.find((p) => p.day === dayAgo(0))!.views).toBe(4);
      expect(daily.points.find((p) => p.day === dayAgo(1))!.views).toBe(0); // zero-filled

      await expect(callRpc("videoAnalytics.getTimeSeriesForUser", { days: 1000 }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });
});

describe("purgeUserAnalytics", () => {
  test("removes the user's snapshots and daily stats (YouTube authorization revoked)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      const v = await mkVideo(tx, user.id);
      await tx.insert(videoAnalytics).values({ userId: user.id, videoId: v.id, youtubeVideoId: v.publishedVideoId!, day: dayAgo(1), views: 1 });
      await tx.insert(videoDailyStats).values({ videoId: v.id, userId: user.id, day: dayAgo(1), views: 1 });
      const count = async () => ({
        a: (await tx.select().from(videoAnalytics).where(sql`user_id = ${user.id}`)).length,
        d: (await tx.select().from(videoDailyStats).where(sql`user_id = ${user.id}`)).length,
      });
      expect(await count()).toEqual({ a: 1, d: 1 });
      await purgeUserAnalytics(tx, user.id);
      expect(await count()).toEqual({ a: 0, d: 0 });
      await purgeUserAnalytics(tx, user.id); // idempotent
      // the video itself is untouched
      expect((await tx.select().from(videos).where(sql`id = ${v.id}`)).length).toBe(1);
    });
  });
});

// ─── YouTube Analytics API client ────────────────────────────────────────────

describe("runReport", () => {
  test("builds the documented request and classifies errors without leaking the token", async () => {
    const calls = mockFetch(() => json({ columnHeaders: DAY_HEADERS, rows: [["2026-10-08", 1, 2, 3, 4, 5, 6, 7]] }));
    const t = await runReport("tok-1", { channelId: "UC1", startDate: "2026-10-03", endDate: "2026-10-09", metrics: ["views", "likes"], dimensions: ["day"], videoIds: ["a", "b"], sort: "day" });
    expect(t.rows.length).toBe(1);
    const q = calls[0].url.searchParams;
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://youtubeanalytics.googleapis.com/v2/reports");
    expect(q.get("ids")).toBe("channel==UC1");
    expect(q.get("filters")).toBe("video==a,b");
    expect(q.get("dimensions")).toBe("day");
    expect(q.get("metrics")).toBe("views,likes");
    expect(q.get("sort")).toBe("day");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");

    for (const [status, kind] of [[401, "auth"], [403, "forbidden"], [429, "rate_limited"], [400, "bad_request"], [503, "server"]] as const) {
      mockFetch(() => new Response("oops tok-1", { status }));
      const err = await runReport("tok-1", { channelId: "UC1", startDate: "a", endDate: "b", metrics: ["views"] }).catch((e) => e);
      expect(err).toBeInstanceOf(YtAnalyticsError);
      expect(err.kind).toBe(kind);
    }
    mockFetch(() => json({}));
    expect((await runReport("t", { channelId: "UC1", startDate: "a", endDate: "b", metrics: ["views"] })).rows).toEqual([]);
  });

  test("dailyRowsFromTable maps video ids, rounds counters and drops unknown videos / bad days", () => {
    const table = {
      headers: HEADERS.map((h) => h.name),
      rows: [
        ["yt1", "2026-10-08", 10.4, 5.5, 30, 1, 2, 3, 4],
        ["yt1", "2026-10-08", 99, 9, 9, 9, 9, 9, 9], // duplicate (video, day): last wins
        ["nope", "2026-10-08", 1, 1, 1, 1, 1, 1, 1],
        ["yt1", "garbage", 1, 1, 1, 1, 1, 1, 1],
      ],
    };
    const rows = dailyRowsFromTable(table, "u1", new Map([["yt1", "vid-1"]]));
    expect(rows).toEqual([{ videoId: "vid-1", userId: "u1", day: "2026-10-08", views: 99, watchTimeMinutes: 9, avgViewDurationSec: 9, likes: 9, comments: 9, subscribersGained: 9, subscribersLost: 9 }]);
  });
});

// ─── daily ingest ────────────────────────────────────────────────────────────

describe("daily ingest (mocked YouTube Analytics API)", () => {
  const NOW = new Date("2026-10-09T10:00:00Z");

  function deps(tx: DbLike, over: Partial<IngestDeps> = {}) {
    const quota: number[] = [];
    const d: IngestDeps = {
      db: tx,
      getToken: async () => ({ accessToken: "access-tok", channelId: "UC-TEST" }),
      addQuota: async (_u, units) => void quota.push(units),
      getQuotaUsed: async () => 0,
      now: () => NOW,
      ...over,
    };
    return { d, quota };
  }
  const batchBody = (a: string, b: string, aViews: number) => ({
    columnHeaders: HEADERS,
    rows: [
      [a, "2026-10-07", aViews, 5.5, 30, 1, 0, 2, 1],
      [a, "2026-10-08", 20, 6, 31, 2, 1, 0, 0],
      [b, "2026-10-08", 7, 1, 10, 0, 0, 0, 0],
      ["unknown-video", "2026-10-08", 1, 1, 1, 1, 1, 1, 1],
    ],
  });

  test("pulls the rolling 7-day window and upserts idempotently (re-running overwrites revised numbers)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      const a = await mkVideo(tx, user.id, { publishedVideoId: "yt-AAA" });
      const b = await mkVideo(tx, user.id, { publishedVideoId: "yt-BBB" });
      await mkVideo(tx, user.id, { status: "draft", publishedVideoId: null }); // never queried
      const target = { userId: user.id, channelRowId: randomUUID() };
      const { d, quota } = deps(tx);

      let aViews = 10;
      const calls = mockFetch(() => json(batchBody("yt-AAA", "yt-BBB", aViews)));

      const first = await ingestUserDailyStats(d, target);
      expect(first).toMatchObject({ status: "ok", rows: 3, requests: 1 });
      expect(quota).toEqual([1]); // one quota unit per API request

      const q = calls[0].url.searchParams;
      expect(q.get("ids")).toBe("channel==UC-TEST");
      expect(q.get("startDate")).toBe("2026-10-03");
      expect(q.get("endDate")).toBe("2026-10-09");
      expect(q.get("dimensions")).toBe("video,day");
      expect(new Set(q.get("filters")!.replace("video==", "").split(","))).toEqual(new Set(["yt-AAA", "yt-BBB"]));
      expect(q.get("metrics")).toBe("views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained,subscribersLost");
      expect(q.get("metrics")).not.toMatch(/impressions|ClickThrough/i); // never requested
      expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer access-tok");

      const read = () => tx.select().from(videoDailyStats).where(sql`user_id = ${user.id}`).orderBy(videoDailyStats.videoId, videoDailyStats.day);
      let rows = await read();
      expect(rows.length).toBe(3);
      const aRow = rows.find((r) => r.videoId === a.id && r.day === "2026-10-07")!;
      expect(aRow).toMatchObject({ views: 10, watchTimeMinutes: 5.5, avgViewDurationSec: 30, likes: 1, subscribersGained: 2, subscribersLost: 1 });
      expect(rows.find((r) => r.videoId === b.id)).toMatchObject({ day: "2026-10-08", views: 7 });
      expect(rows.every((r) => r.impressions === null && r.ctr === null)).toBe(true);

      // YouTube revised the older day: second run overwrites, never duplicates
      aViews = 12;
      const second = await ingestUserDailyStats(d, target);
      expect(second.rows).toBe(3);
      rows = await read();
      expect(rows.length).toBe(3);
      expect(rows.find((r) => r.videoId === a.id && r.day === "2026-10-07")!.views).toBe(12);
    });
  });

  test("falls back to single-video day reports when the batched shape is rejected", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      const a = await mkVideo(tx, user.id, { publishedVideoId: "yt-AAA" });
      await mkVideo(tx, user.id, { publishedVideoId: "yt-BBB" });
      const { d } = deps(tx);
      const calls = mockFetch((url) => {
        if (url.searchParams.get("dimensions") === "video,day") return json({ error: "bad" }, 400);
        if (url.searchParams.get("filters") === "video==yt-AAA") return json({ columnHeaders: DAY_HEADERS, rows: [["2026-10-08", 9, 1, 2, 3, 4, 5, 6]] });
        return json({ error: "bad" }, 400); // yt-BBB not reportable: skipped, not fatal
      });
      const res = await ingestUserDailyStats(d, { userId: user.id, channelRowId: randomUUID() });
      expect(res.status).toBe("ok");
      expect(res.rows).toBe(1);
      expect(calls.length).toBe(3); // 1 batch + 2 singles
      const rows = await tx.select().from(videoDailyStats).where(sql`user_id = ${user.id}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ videoId: a.id, day: "2026-10-08", views: 9 });
    });
  });

  test("skips users near the shared quota ceiling without calling YouTube", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      await mkVideo(tx, user.id);
      const { d } = deps(tx, { getQuotaUsed: async () => INGEST_QUOTA_CEILING });
      const calls = mockFetch(() => json({}));
      expect((await ingestUserDailyStats(d, { userId: user.id, channelRowId: randomUUID() })).status).toBe("skipped_quota");
      expect(calls.length).toBe(0);
    });
  });

  test("users without published videos are a no-op", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      const { d } = deps(tx);
      const calls = mockFetch(() => json({}));
      expect((await ingestUserDailyStats(d, { userId: user.id, channelRowId: randomUUID() })).status).toBe("no_videos");
      expect(calls.length).toBe(0);
    });
  });

  test("401 marks the channel token_expired; 403 and token failures are reported, 429 propagates for retry", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      await mkVideo(tx, user.id);
      const [ch] = await tx
        .insert(youtubeChannels)
        .values({ userId: user.id, channelId: `UC-${randomUUID()}`, accessToken: "x", tokenExpiry: new Date(Date.now() + 3600_000), oauthStatus: "connected", isPrimary: true })
        .returning();
      const target = { userId: user.id, channelRowId: ch.id };
      const { d } = deps(tx);

      mockFetch(() => new Response("unauthorized", { status: 401 }));
      expect((await ingestUserDailyStats(d, target)).status).toBe("auth_failed");
      expect((await tx.select().from(youtubeChannels).where(sql`id = ${ch.id}`))[0].oauthStatus).toBe("token_expired");

      mockFetch(() => new Response("forbidden", { status: 403 }));
      expect((await ingestUserDailyStats(d, target)).status).toBe("forbidden");

      mockFetch(() => new Response("slow down", { status: 429 }));
      await expect(ingestUserDailyStats(d, target)).rejects.toMatchObject({ kind: "rate_limited" });

      mockFetch(() => new Response("boom", { status: 500 }));
      expect((await ingestUserDailyStats(d, target)).status).toBe("error");

      const calls = mockFetch(() => json({}));
      const { d: noToken } = deps(tx, { getToken: async () => { throw new Error("revoked"); } });
      expect((await ingestUserDailyStats(noToken, target)).status).toBe("auth_failed");
      expect(calls.length).toBe(0);
    });
  });

  test("selectIngestUsers: only connected primary channels with published videos, keyset paginated", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      const mkChannel = (status: "connected" | "revoked", primary = true) =>
        tx.insert(youtubeChannels).values({ userId: user.id, channelId: `UC-${randomUUID()}`, accessToken: "x", tokenExpiry: new Date(), oauthStatus: status, isPrimary: primary }).returning();

      await mkVideo(tx, user.id);
      const [ch] = await mkChannel("revoked");
      const none = (await selectIngestUsers(tx, null, 100)).filter((u) => u.userId === user.id);
      expect(none).toEqual([]); // revoked channel is skipped

      await tx.update(youtubeChannels).set({ oauthStatus: "connected" }).where(sql`id = ${ch.id}`);
      const found = (await selectIngestUsers(tx, null, 100)).filter((u) => u.userId === user.id);
      expect(found).toEqual([{ userId: user.id, channelRowId: ch.id }]);
      expect((await selectIngestUsers(tx, user.id, 100)).some((u) => u.userId === user.id)).toBe(false); // cursor excludes it
    });
  });

  test("runIngestChunk (real token + quota helpers, mocked API) processes the user and records quota", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await clean(tx, user.id);
      await mkVideo(tx, user.id, { publishedVideoId: "yt-CHUNK" });
      await tx.insert(youtubeChannels).values({
        userId: user.id,
        channelId: "UC-CHUNK",
        accessToken: encryptSecret("live-token"),
        tokenExpiry: new Date(Date.now() + 3600_000),
        oauthStatus: "connected",
        isPrimary: true,
      });
      const day = dayAgo(1);
      mockFetch(() => json({ columnHeaders: HEADERS, rows: [["yt-CHUNK", day, 5, 1, 2, 3, 4, 5, 6]] }));
      const out = await runIngestChunk({ payload: { runId: "test-run", cursor: null } }, { db: tx, now: new Date() });
      const mine = out.results.find((r) => r.userId === user.id)!;
      expect(mine).toMatchObject({ status: "ok", rows: 1 });
      expect(out.next).toBeNull(); // fewer users than a full chunk: the run is complete
      expect((await tx.select().from(videoDailyStats).where(sql`user_id = ${user.id}`)).length).toBe(1);
      const [q] = (await tx.execute(sql`select units_used from youtube_quota_usage where user_id = ${user.id}`)) as unknown as { units_used: number }[];
      expect(Number(q.units_used)).toBe(1);
    });
  });
});


describe("analytics job registration", () => {
  test("registers the chunk task and a 6-hourly sweep", () => {
    expect(taskHandlers[INGEST_KIND]).toBeDefined();
    const s = sweeps.find((x) => x.name === "analytics.dailyIngest")!;
    expect(s.everyMs).toBe(6 * 60 * 60 * 1000);
    expect(analyticsHandlers.sweeps).toContain(dailyIngestSweep);
  });

  test("the sweep enqueues one deduped start task per run", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const now = new Date("2099-01-01T10:15:00Z");
      await dailyIngestSweep.run({ db: tx, now });
      await dailyIngestSweep.run({ db: tx, now }); // a second tick in the same run changes nothing
      const rows = await tx.select().from(tasks).where(sql`kind = ${INGEST_KIND} and dedupe_key = 'analytics.ingest:2099-01-01T10:start'`);
      expect(rows.length).toBe(1);
      expect(rows[0].payload).toEqual({ runId: "2099-01-01T10", cursor: null });
      expect(rows[0].status).toBe("pending");
    });
  });
});

// ─── PostHog (server) ────────────────────────────────────────────────────────

describe("posthog server helper", () => {
  test("is a silent no-op without a key and drops PII-looking properties", async () => {
    const saved = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    try {
      const calls = mockFetch(() => json({}));
      await expect(captureServerEvent("user-1", "video_published", { plan: "pro" })).resolves.toBeUndefined();
      expect(calls.length).toBe(0);
    } finally {
      if (saved !== undefined) process.env.NEXT_PUBLIC_POSTHOG_KEY = saved;
    }
    expect(sanitizeProps({ plan: "pro", email: "a@b.c", userName: "x", accessToken: "t", apiKey: "k", count: 2, skip: undefined })).toEqual({ plan: "pro", count: 2 });
  });
});
