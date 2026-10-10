/**
 * Daily YouTube quota pre-check for the content-intelligence actions (searchByKeyword 100 units, getContentGaps
 * 25 + 100 per competitor). External APIs are mocked; the database work is real and rolled back.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { youtubeChannels, youtubeQuotaUsage } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { INGEST_QUOTA_CEILING } from "@/server/lib/analytics/dailyIngest";
import { json, mockFetch, setPlan } from "@/server/lib/generation/testkit";
import { INTERACTIVE_QUOTA_CEILING } from "@/server/lib/youtubeQuota";
import { callRpc, countQueries, inRolledBackTx } from "@/server/testing";

setDefaultTimeout(120_000);

let net: ReturnType<typeof mockFetch>;
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  handler = () => new Response("not mocked", { status: 404 });
  net = mockFetch((url, init) => handler(url, init));
});
afterEach(() => {
  net.restore();
});

async function connect(tx: Parameters<typeof setPlan>[0], userId: string) {
  const [ch] = await tx
    .insert(youtubeChannels)
    .values({
      userId,
      channelId: `UC_test_${Math.random().toString(36).slice(2, 12)}`,
      channelName: "Test",
      accessToken: encryptSecret("ya29.test-access"),
      refreshToken: encryptSecret("1//refresh"),
      tokenExpiry: new Date(Date.now() + 3_600_000),
      isPrimary: true,
    })
    .returning();
  return ch;
}
const quota = async (tx: Parameters<typeof setPlan>[0], userId: string) =>
  (await tx.select().from(youtubeQuotaUsage).where(eq(youtubeQuotaUsage.userId, userId))).reduce((n, r) => n + r.unitsUsed, 0);

describe("daily YouTube quota pre-check", () => {
  // The per-user daily ceiling for user-triggered calls (same figure as the analytics ingest: headroom for uploads).
  const CEILING = 8_000;
  const SEARCH_COST = 100; //                      search.list
  const GAPS_BASE_COST = 25; //                    videos.list?chart=mostPopular, 25 videos at 1 unit each
  const gapsCost = (competitors: number) => GAPS_BASE_COST + SEARCH_COST * Math.min(competitors, 5);
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `UCcompetitor_${String(i).padStart(8, "0")}`);

  test("the ceiling for user-triggered calls is the analytics ingest's ceiling (one reserve for uploads, not two)", () => {
    expect(INTERACTIVE_QUOTA_CEILING).toBe(CEILING);
    expect(INTERACTIVE_QUOTA_CEILING).toBe(INGEST_QUOTA_CEILING);
  });

  async function setQuotaUsed(tx: Parameters<typeof setPlan>[0], userId: string, unitsUsed: number) {
    await tx.insert(youtubeQuotaUsage).values({ userId, date: new Date().toISOString().slice(0, 10), unitsUsed });
  }
  const ytCalls = () => net.calls.filter((c) => c.url.includes("googleapis.com/youtube"));
  const quotaStatements = (statements: string[]) => statements.filter((q) => q.includes("youtube_quota_usage"));
  const searchHandler = (url: string) => {
    if (url.includes("chart=mostPopular")) return json({ items: [{ id: "v1", snippet: { title: "A", tags: ["x"] }, statistics: {} }] });
    if (url.includes("/search?")) return json({ items: [{ id: { videoId: "s1" }, snippet: { title: "Found" } }] });
    return new Response("", { status: 404 });
  };

  async function connected(tx: Parameters<typeof setPlan>[0], userId: string) {
    await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, userId));
    return connect(tx, userId);
  }

  test("searchByKeyword: not enough quota left for the 100-unit call -> RATE_LIMITED, YouTube is never called, nothing is recorded", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await connected(tx, user.id);
      await setQuotaUsed(tx, user.id, CEILING - SEARCH_COST + 1);
      handler = searchHandler;
      const err = await callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "pasta" }, { user, tx }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "RATE_LIMITED" });
      expect(ytCalls()).toHaveLength(0);
      expect(await quota(tx, user.id)).toBe(CEILING - SEARCH_COST + 1);
    });
  });

  test("searchByKeyword: remaining quota equal to the cost still goes through and the 100 units are recorded", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await connected(tx, user.id);
      await setQuotaUsed(tx, user.id, CEILING - SEARCH_COST);
      handler = searchHandler;
      const found = (await callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "pasta" }, { user, tx })) as { videoId: string }[];
      expect(found.map((f) => f.videoId)).toEqual(["s1"]);
      expect(ytCalls()).toHaveLength(1);
      expect(await quota(tx, user.id)).toBe(CEILING);
      // ...and now the day is full: the next call is refused.
      await expect(callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "pasta" }, { user, tx })).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(ytCalls()).toHaveLength(1);
    });
  });

  test("getContentGaps: the cost follows the competitors asked for (25 + 100 each, at most 5), at the boundary", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await connected(tx, user.id);
      handler = searchHandler;
      const gaps = (n: number) => callRpc("actions.contentIntelligence.getContentGaps", { competitorChannelIds: ids(n) }, { user, tx });

      // 2 competitors cost 225: one unit short is refused, exactly enough runs.
      await setQuotaUsed(tx, user.id, CEILING - gapsCost(2) + 1);
      await expect(gaps(2)).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(ytCalls()).toHaveLength(0);
      await tx.update(youtubeQuotaUsage).set({ unitsUsed: CEILING - gapsCost(2) }).where(eq(youtubeQuotaUsage.userId, user.id));
      await gaps(2);
      expect(ytCalls()).toHaveLength(3); // trending + 2 competitor searches
      expect(await quota(tx, user.id)).toBe(CEILING - gapsCost(2) + 1 + 2 * SEARCH_COST); // 1 trending video came back

      // No competitors: only the 25-unit trending call is priced.
      net.calls.length = 0;
      await tx.update(youtubeQuotaUsage).set({ unitsUsed: CEILING - GAPS_BASE_COST }).where(eq(youtubeQuotaUsage.userId, user.id));
      await gaps(0);
      expect(ytCalls()).toHaveLength(1);

      // More than 5 ids are capped at 5 (the handler only looks up 5): cost 525, the figure in the audit.
      net.calls.length = 0;
      await tx.update(youtubeQuotaUsage).set({ unitsUsed: CEILING - 525 + 1 }).where(eq(youtubeQuotaUsage.userId, user.id));
      await expect(gaps(9)).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(ytCalls()).toHaveLength(0);
      await tx.update(youtubeQuotaUsage).set({ unitsUsed: CEILING - 525 }).where(eq(youtubeQuotaUsage.userId, user.id));
      await gaps(9);
      expect(ytCalls()).toHaveLength(6); // trending + 5 competitor searches
    });
  });

  test("the pre-check is one extra select on youtube_quota_usage per call, however many competitors are asked for; users without YouTube pay nothing", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await connected(tx, user.id);
      handler = searchHandler;

      const search = await countQueries(() => callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "pasta" }, { user, tx }));
      const searchQuota = quotaStatements(search.statements);
      expect(searchQuota.filter((q) => /^\s*select/i.test(q))).toHaveLength(1); // the pre-check
      expect(searchQuota.filter((q) => /^\s*insert/i.test(q))).toHaveLength(1); //  the existing recording

      const noCompetitors = await countQueries(() => callRpc("actions.contentIntelligence.getContentGaps", { competitorChannelIds: [] }, { user, tx }));
      const fiveCompetitors = await countQueries(() => callRpc("actions.contentIntelligence.getContentGaps", { competitorChannelIds: ids(5) }, { user, tx }));
      for (const run of [noCompetitors, fiveCompetitors]) {
        expect(quotaStatements(run.statements).filter((q) => /^\s*select/i.test(q))).toHaveLength(1);
      }
      // Only the recordings grow with the competitors (one insert each); the pre-check and everything else do not.
      expect(fiveCompetitors.queries - noCompetitors.queries).toBe(quotaStatements(fiveCompetitors.statements).length - quotaStatements(noCompetitors.statements).length);

      await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
      const none = await countQueries(() => callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "pasta" }, { user, tx }));
      expect(quotaStatements(none.statements)).toHaveLength(0);
    });
  });
});
