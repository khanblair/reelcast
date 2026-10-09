import { describe, expect, test } from "bun:test";
import { generations, videoAnalytics } from "@/db/schema";
import { scoreHourBuckets } from "@/server/lib/content/suggestedTimes";
import { insertVideo } from "@/server/lib/content/testing";
import { callRpc, inRolledBackTx } from "@/server/testing";

type W = Record<string, unknown>;
type Stats = {
  statusData: { name: string; count: number }[];
  timelineData: { date: string; timestamp: number; count: number }[];
  totalVideos: number;
  totalStorageBytes: number;
  totalDurationSeconds: number;
};

const DAY = 24 * 3_600_000;
const utcMidnight = (ms: number) => Math.floor(ms / DAY) * DAY;

describe("analytics.getDashboardStats", () => {
  test("aggregates status, the last 7 UTC days (empty days included) and totals in SQL", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const today = utcMidnight(Date.now());
      const at = (daysAgo: number, hour = 12) => new Date(today - daysAgo * DAY + hour * 3_600_000);
      await insertVideo(tx, user.id, { status: "draft", rawFileSize: 1000, duration: 30, createdAt: at(0, 1) });
      await insertVideo(tx, user.id, { status: "draft", rawFileSize: 2000, duration: 45.5, createdAt: at(0, 2) });
      await insertVideo(tx, user.id, { status: "ready", rawFileSize: 5_000_000_000, createdAt: at(2) });
      await insertVideo(tx, user.id, { status: "published", rawFileSize: 10, duration: 60, createdAt: at(6, 0) });
      await insertVideo(tx, user.id, { status: "published", rawFileSize: 5, createdAt: at(7) }); // outside the 7-day window, still in the totals
      await insertVideo(tx, (await makeUser()).id, { status: "draft", rawFileSize: 999 }); // someone else's

      const stats = (await callRpc("analytics.getDashboardStats", {}, { user, tx })) as Stats;
      expect(Object.fromEntries(stats.statusData.map((s) => [s.name, s.count]))).toEqual({ Draft: 2, Ready: 1, Published: 2 });
      expect(stats.totalVideos).toBe(5);
      expect(stats.totalStorageBytes).toBe(5_000_003_015);
      expect(stats.totalDurationSeconds).toBeCloseTo(135.5, 6);

      // 7 consecutive UTC days ending today, empty days included
      expect(stats.timelineData).toHaveLength(7);
      expect(stats.timelineData.map((d) => d.timestamp)).toEqual(Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY));
      expect(stats.timelineData.map((d) => d.count)).toEqual([1, 0, 0, 0, 1, 0, 2]);
      const last = new Date(today);
      expect(stats.timelineData[6].date).toBe(`${last.getUTCMonth() + 1}/${last.getUTCDate()}`);

      // a user with no videos gets zeros; signed out gets null
      const empty = (await callRpc("analytics.getDashboardStats", {}, { user: await makeUser(), tx })) as Stats;
      expect(empty).toMatchObject({ statusData: [], totalVideos: 0, totalStorageBytes: 0, totalDurationSeconds: 0 });
      expect(empty.timelineData).toHaveLength(7);
      expect(await callRpc("analytics.getDashboardStats", {}, { user: null })).toBeNull();
    });
  });
});

describe("scheduling.getSuggestedTimes", () => {
  const bucket = (hourUtc: number, count: number, avgViews: number, avgCtr = 0) => ({ hourUtc, count, totalViews: avgViews * count, totalCtr: avgCtr * count });

  test("scoring: not enough data, views-only ranking (no CTR), and CTR weighting", () => {
    expect(scoreHourBuckets([bucket(9, 4, 100)])).toEqual({ suggestedTimes: null, reason: "not_enough_data", videosNeeded: 5 });

    // views only (ctr never populated): ranking is by average views, score tops out at the 40% views weight
    const noCtr = scoreHourBuckets([bucket(9, 4, 100), bucket(18, 2, 2000)]);
    expect(noCtr).toMatchObject({ reason: "analytics", totalVideosAnalysed: 6 });
    const t = (noCtr as { suggestedTimes: W[] }).suggestedTimes;
    expect(t.map((s) => s.hourUtc)).toEqual([18, 9]);
    expect(t[0]).toMatchObject({ hourEat: 21, avgViews: 2000, avgCtr: 0, sampleSize: 2, confidence: "low", score: 0.4 });
    expect(t[1]).toMatchObject({ hourEat: 12, avgViews: 100, sampleSize: 4, confidence: "high", score: 0.02 });

    // CTR weighs in at 60%, and only the top three hours are returned
    const withCtr = scoreHourBuckets([bucket(9, 4, 100), bucket(18, 2, 2000), bucket(6, 1, 10, 0.2), bucket(1, 1, 1)]);
    const w = (withCtr as { suggestedTimes: W[] }).suggestedTimes;
    expect(w).toHaveLength(3);
    expect(w[0]).toMatchObject({ hourUtc: 6, avgCtr: 0.2, score: 0.6 });
  });

  test("the RPC buckets by UTC publish hour using each video's latest snapshot", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      expect(await callRpc("scheduling.getSuggestedTimes", {}, { user, tx })).toEqual({ reason: "not_enough_data", videosNeeded: 5 });
      await expect(callRpc("scheduling.getSuggestedTimes", {}, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

      const publishedAt = (hour: number) => new Date(Date.UTC(2026, 0, 10, hour, 30));
      const mk = (hour: number, uid = user.id) => insertVideo(tx, uid, { status: "published", publishedVideoId: `yt${crypto.randomUUID()}`, publishedAt: publishedAt(hour) });
      const snap = (videoId: string, day: string, fetchedAt: Date, views: number, ctr?: number) =>
        tx.insert(videoAnalytics).values({ userId: user.id, videoId, youtubeVideoId: "yt", day, fetchedAt, views, ctr });

      const a = await mk(3);
      await snap(a.id, "2026-01-11", new Date("2026-01-11T10:00:00Z"), 5); // superseded by the newer snapshot
      await snap(a.id, "2026-01-12", new Date("2026-01-12T10:00:00Z"), 500);
      const b = await mk(3);
      await snap(b.id, "2026-01-11", new Date("2026-01-11T10:00:00Z"), 300);
      for (const views of [100, 100, 100]) await snap((await mk(15)).id, "2026-01-11", new Date("2026-01-11T10:00:00Z"), views);
      await mk(3); // published but never analysed: not counted
      await insertVideo(tx, user.id, { status: "ready", publishedAt: publishedAt(3) }); // not published: not counted
      await mk(3, (await makeUser()).id); // someone else's

      const out = (await callRpc("scheduling.getSuggestedTimes", {}, { user, tx })) as { reason: string; totalVideosAnalysed: number; suggestedTimes: W[] };
      expect(out.reason).toBe("analytics");
      expect(out.totalVideosAnalysed).toBe(5);
      expect(out.suggestedTimes.map((s) => s.hourUtc)).toEqual([3, 15]);
      expect(out.suggestedTimes[0]).toMatchObject({ hourEat: 6, avgViews: 400, avgCtr: 0, sampleSize: 2, score: 0.4 }); // (500 + 300) / 2, not (5 + 500 + 300) / 3
      expect(out.suggestedTimes[1]).toMatchObject({ hourEat: 18, avgViews: 100, sampleSize: 3, confidence: "high", score: 0.1 });
    });
  });
});

describe("generations.listByUser", () => {
  test("lists my generations newest first and nobody else's", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const v = await insertVideo(tx, user.id, { sourceType: "generate" });
      const base = { userId: user.id, videoId: v.id, model: "veo", prompt: "p", resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, generateAudio: true };
      const [a] = await tx.insert(generations).values({ ...base, createdAt: new Date("2026-01-01T00:00:00Z") }).returning();
      const [b] = await tx.insert(generations).values({ ...base, status: "failed", error: "nope", createdAt: new Date("2026-02-01T00:00:00Z") }).returning();

      const mine = (await callRpc("generations.listByUser", {}, { user, tx })) as W[];
      expect(mine.map((g) => g._id)).toEqual([b.id, a.id]);
      expect(mine[0]).toMatchObject({ status: "failed", error: "nope", videoId: v.id });
      expect(await callRpc("generations.listByUser", {}, { user: await makeUser(), tx })).toEqual([]);
      expect(await callRpc("generations.listByUser", {}, { user: null })).toEqual([]);
    });
  });
});
