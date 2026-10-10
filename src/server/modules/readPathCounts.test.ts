/**
 * Statement counts + equivalence for the hot / polled read paths (N+1 audit, round 2).
 *
 * Every statement is a network round trip and production runs on ONE connection, so the NUMBER OF STATEMENTS is what
 * matters. Each case proves two things:
 *   - the count is fixed (it does not grow with the number of rows), and
 *   - the result equals what the previous implementation returned. The previous implementations are kept below as
 *     `legacy*` reference functions (verbatim copies of the code that was replaced) and compared on the same data.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { aiSessions, paymentOrders, settings, subscriptions, usageLedger, users, videoAnalytics, videoMetadataVersions } from "@/db/schema";
import { LIVE_STATUSES, type OrderRow, type SubRow } from "@/server/billing/core";
import { getCurrency, getPlanPrices } from "@/server/billing/plans";
import { paymentsReady } from "@/server/billing/service";
import { buildBillingStatus, paymentDto, subscriptionDto } from "@/server/billing/status";
import { encryptSecret } from "@/server/crypto";
import { getChannelTotals } from "@/server/lib/analytics/queries";
import { listMetadataHistory } from "@/server/lib/content/metadata";
import { getDashboardStats } from "@/server/lib/content/stats";
import { MIN_DATA_POINTS, computeSuggestedTimes, loadHourBuckets, scoreHourBuckets } from "@/server/lib/content/suggestedTimes";
import { insertVideo } from "@/server/lib/content/testing";
import { META_JSON, geminiText, json, mkVideo, mockFetch, putSettings, setEnv, setPlan, setPlatformKeys } from "@/server/lib/generation/testkit";
import { consumeQuota, getUsage, getUsageWithPlanSource, limitsFor, monthKey } from "@/server/lib/usage";
import { toWire } from "@/server/rpc/wire";
import { callRpc, countQueries, inRolledBackTx } from "@/server/testing";

setDefaultTimeout(240_000);

const CLOUD = `https://res.cloudinary.com/${process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || "demo"}/video/upload/v1/clip.mp4`;
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);

// ─── the previous implementations, kept as references ────────────────────────

/** lib/usage.ts getUsage before: two sequential selects. */
async function legacyGetUsage(db: DbLike, userId: string) {
  const [u] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1);
  const [row] = await db
    .select()
    .from(usageLedger)
    .where(and(eq(usageLedger.userId, userId), eq(usageLedger.month, monthKey())))
    .limit(1);
  const plan = u?.plan ?? "free";
  const limits = limitsFor(plan);
  return {
    plan,
    month: monthKey(),
    used: {
      videosUploaded: row?.videosUploaded ?? 0,
      metadataGenerated: row?.metadataGenerated ?? 0,
      veoGenerated: row?.veoGenerated ?? 0,
      aiMessagesUsed: row?.aiMessagesUsed ?? 0,
    },
    limits,
  };
}

/** billing/status.ts buildBillingStatus before: users, live sub, fallback sub, renewal order, then payments + usage + config. */
async function legacyBuildBillingStatus(db: DbLike, userId: string, cfg: { prices: ReturnType<typeof getPlanPrices>; currency: string; now?: Date }) {
  const now = cfg.now ?? new Date();
  const [user] = await db.select({ plan: users.plan, planSource: users.planSource }).from(users).where(eq(users.id, userId)).limit(1);

  let [sub] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, [...LIVE_STATUSES])))
    .limit(1);
  if (!sub) {
    [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).orderBy(desc(subscriptions.createdAt)).limit(1);
  }

  let renewalOrder: OrderRow | undefined;
  if (sub && (sub.status === "active" || sub.status === "past_due")) {
    [renewalOrder] = await db
      .select()
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.subscriptionId, sub.id),
          eq(paymentOrders.purpose, "renewal"),
          isNull(paymentOrders.appliedAt),
          or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0)),
          or(isNull(paymentOrders.statusText), notInArray(paymentOrders.statusText, ["submit_failed", "submit_abandoned", "superseded", "ABANDONED"])),
        ),
      )
      .orderBy(desc(paymentOrders.createdAt))
      .limit(1);
  }

  const visible = and(eq(paymentOrders.userId, userId), isNotNull(paymentOrders.orderTrackingId), or(isNull(paymentOrders.statusText), notInArray(paymentOrders.statusText, ["superseded"])));
  const [paymentRows, usage, ready] = await Promise.all([
    db.select().from(paymentOrders).where(visible).orderBy(desc(paymentOrders.createdAt)).limit(5),
    legacyGetUsage(db, userId),
    paymentsReady(db),
  ]);
  const payments = paymentRows.map(paymentDto);
  const items: Record<string, { used: number; limit: number }> = {};
  for (const field of Object.keys(usage.used) as (keyof typeof usage.used)[]) items[field] = { used: usage.used[field], limit: usage.limits[field] };

  return {
    plan: user?.plan ?? "free",
    planSource: user?.planSource ?? "default",
    selfServe: (user?.planSource ?? "default") !== "admin",
    paymentsEnabled: ready.configured && ready.ipnRegistered && !!process.env.NEXT_PUBLIC_APP_URL,
    currency: cfg.currency,
    prices: cfg.prices,
    subscription: sub ? subscriptionDto(sub, now) : null,
    renewalOrder: renewalOrder
      ? { id: renewalOrder.id, plan: renewalOrder.plan, amount: Number(renewalOrder.amount), currency: renewalOrder.currency, createdAt: renewalOrder.createdAt }
      : null,
    payments,
    usage: { month: usage.month, items },
  };
}

/** modules/queue.ts getQueueStats before: a grouped count, then the settings row. */
async function legacyQueueStats(db: DbLike, userId: string) {
  const counts = (await db.execute(sql`
    select status, count(*)::int as n
    from videos
    where user_id = ${userId} and status in ('ready', 'scheduled')
    group by status
  `)) as unknown as { status: string; n: number }[];
  const [s] = await db.select({ nextAt: settings.autoPublishNextAt }).from(settings).where(eq(settings.userId, userId)).limit(1);
  const count = (status: string) => Number(counts.find((c) => c.status === status)?.n ?? 0);
  return { readyCount: count("ready"), scheduledCount: count("scheduled"), nextPublishAt: s?.nextAt ?? null };
}

/** lib/content/stats.ts getDashboardStats before: two sequential statements. */
async function legacyDashboardStats(db: DbLike, userId: string) {
  type StatusRow = { status: string; n: number; bytes: number; secs: number };
  type DayRow = { day: string; ts: number; n: number };
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const statusRows = (await db.execute(sql`
    select status,
           count(*)::int as n,
           coalesce(sum(raw_file_size), 0)::float8 as bytes,
           coalesce(sum(duration), 0)::float8 as secs
    from videos
    where user_id = ${userId}
    group by status
    order by min(created_at)
  `)) as unknown as StatusRow[];
  const dayRows = (await db.execute(sql`
    select to_char(g.day, 'YYYY-MM-DD') as day,
           (extract(epoch from g.day) * 1000)::float8 as ts,
           count(v.id)::int as n
    from generate_series(
           ((now() at time zone 'utc')::date - 6)::timestamp,
           (now() at time zone 'utc')::date::timestamp,
           interval '1 day'
         ) as g(day)
    left join videos v
      on v.user_id = ${userId}
     and v.created_at >= (g.day at time zone 'utc')
     and v.created_at < ((g.day + interval '1 day') at time zone 'utc')
    group by g.day
    order by g.day
  `)) as unknown as DayRow[];
  return {
    statusData: statusRows.map((r) => ({ name: capitalize(r.status), count: Number(r.n) })),
    timelineData: dayRows.map((r) => {
      const [, m, d] = r.day.split("-");
      return { date: `${Number(m)}/${Number(d)}`, timestamp: Number(r.ts), count: Number(r.n) };
    }),
    totalVideos: statusRows.reduce((s, r) => s + Number(r.n), 0),
    totalStorageBytes: statusRows.reduce((s, r) => s + Number(r.bytes), 0),
    totalDurationSeconds: statusRows.reduce((s, r) => s + Number(r.secs), 0),
  };
}

/** lib/analytics/queries.ts getChannelTotals before: the aggregate, then the top 5. */
async function legacyChannelTotals(db: DbLike, userId: string) {
  const latest = db
    .selectDistinctOn([videoAnalytics.videoId])
    .from(videoAnalytics)
    .where(eq(videoAnalytics.userId, userId))
    .orderBy(videoAnalytics.videoId, desc(videoAnalytics.day), desc(videoAnalytics.fetchedAt))
    .as("latest");
  const [agg] = await db
    .select({
      totalViews: sql<number>`coalesce(sum(${latest.views}), 0)`.mapWith(Number),
      totalWatchTimeMinutes: sql<number>`coalesce(sum(${latest.watchTimeMinutes}), 0)`.mapWith(Number),
      totalImpressions: sql<number>`coalesce(sum(${latest.impressions}), 0)`.mapWith(Number),
      avgCtr: sql<number | null>`avg(${latest.ctr})`.mapWith((v) => (v === null || v === undefined ? null : Number(v))),
    })
    .from(latest);
  const topVideos = await db
    .select({ videoId: latest.videoId, youtubeVideoId: latest.youtubeVideoId, views: latest.views, watchTimeMinutes: latest.watchTimeMinutes, ctr: latest.ctr })
    .from(latest)
    .orderBy(sql`${latest.views} desc nulls last`)
    .limit(5);
  return { ...agg, topVideos };
}

/** lib/content/suggestedTimes.ts computeSuggestedTimes before: a published count, then the buckets. */
async function legacySuggestedTimes(db: DbLike, userId: string) {
  const [row] = (await db.execute(sql`select count(*)::int as published from videos where user_id = ${userId} and status = 'published'`)) as unknown as { published: number }[];
  if (Number(row?.published ?? 0) < MIN_DATA_POINTS) return { suggestedTimes: null, reason: "not_enough_data" as const, videosNeeded: MIN_DATA_POINTS };
  return scoreHourBuckets(await loadHourBuckets(db, userId));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** `MEASURE=1 bun run test <this file>` prints every before/after statement count. */
const report = (line: string) => {
  if (process.env.MEASURE) console.log(`COUNT ${line}`);
};

/** Same in-process value, and the same wire JSON including key order. */
function expectSame(actual: unknown, expected: unknown) {
  expect(actual).toEqual(expected);
  expect(JSON.stringify(toWire(actual))).toBe(JSON.stringify(toWire(expected)));
}

let restoreEnv: () => void;
let net: ReturnType<typeof mockFetch>;
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;
beforeEach(() => {
  restoreEnv = setEnv({ GEMINI_API_KEY: undefined, NEXT_PUBLIC_APP_URL: "https://app.test" });
  handler = () => new Response("not mocked", { status: 404 });
  net = mockFetch((url, init) => handler(url, init));
});
afterEach(() => {
  net.restore();
  restoreEnv();
});

// ─── billing.getStatus ───────────────────────────────────────────────────────

describe("billing.getStatus", () => {
  const cfg = () => ({ prices: getPlanPrices(), currency: getCurrency(), now: new Date() });

  async function mkSub(tx: DbLike, userId: string, over: Partial<typeof subscriptions.$inferInsert>): Promise<SubRow> {
    const [s] = await tx
      .insert(subscriptions)
      .values({ userId, plan: "pro", status: "active", periodStart: daysAgo(29), periodEnd: new Date(Date.now() + DAY), ...over })
      .returning();
    return s;
  }
  async function mkOrder(tx: DbLike, userId: string, subscriptionId: string | null, over: Partial<typeof paymentOrders.$inferInsert> = {}) {
    const [o] = await tx
      .insert(paymentOrders)
      .values({
        userId,
        subscriptionId,
        merchantRef: `m-${randomUUID()}`,
        orderTrackingId: `t-${randomUUID()}`,
        purpose: "initial",
        plan: "pro",
        amount: "19.00",
        currency: "USD",
        redirectUrl: "https://pay.example/secret-checkout",
        confirmationCode: "CONF-SECRET",
        ...over,
      })
      .returning();
    return o;
  }

  test("same payload as before for every subscription state, in 4 statements instead of 6-7", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const check = async (label: string) => {
        const old = await countQueries(() => legacyBuildBillingStatus(tx, user.id, cfg()));
        const now = await countQueries(() => buildBillingStatus(tx, user.id, cfg()));
        report(`billing.getStatus [${label}] before=${old.queries} after=${now.queries}`);
        expectSame(now.result, old.result);
        expect(now.queries).toBe(4);
        expect(old.queries).toBeGreaterThanOrEqual(6);
        // the wire payload never carries provider secrets / links
        const wire = JSON.stringify(toWire(now.result));
        for (const forbidden of ["secret-checkout", "CONF-SECRET", "redirectUrl", "confirmationCode", "orderTrackingId", "merchantRef"]) expect(wire).not.toContain(forbidden);
        // ... and the SQL never even selects them
        for (const stmt of now.statements) for (const col of ["redirect_url", "confirmation_code", "merchant_ref"]) expect(stmt).not.toContain(col);
        return now.result;
      };

      // S0: a free user with nothing
      const s0 = await check("free, nothing");
      expect(s0.subscription).toBeNull();
      expect(s0.payments).toEqual([]);

      // S1: only an approval_pending (live) subscription; its checkout order is hidden (never opened at the provider)
      const pending = await mkSub(tx, user.id, { status: "approval_pending", periodStart: null, periodEnd: null });
      await mkOrder(tx, user.id, pending.id, { orderTrackingId: null });
      const s1 = await check("approval_pending");
      expect(s1.subscription).toMatchObject({ status: "approval_pending" });
      expect(s1.renewalOrder).toBeNull();

      // S2: active subscription, several open/dead/applied renewal orders, many payments (N > the 5 shown)
      await tx.delete(paymentOrders).where(eq(paymentOrders.userId, user.id));
      await tx.update(subscriptions).set({ status: "active", periodStart: daysAgo(29), periodEnd: new Date(Date.now() + DAY) }).where(eq(subscriptions.id, pending.id));
      await tx.update(users).set({ plan: "pro", planSource: "subscription" }).where(eq(users.id, user.id));
      await mkOrder(tx, user.id, pending.id, { purpose: "renewal", statusCode: null, createdAt: daysAgo(3) });
      await mkOrder(tx, user.id, pending.id, { purpose: "renewal", statusCode: 0, createdAt: daysAgo(1) });
      await mkOrder(tx, user.id, pending.id, { purpose: "renewal", statusText: "superseded", createdAt: daysAgo(0.5) }); // dead (and hidden)
      await mkOrder(tx, user.id, pending.id, { purpose: "renewal", statusCode: 1, appliedAt: daysAgo(0.2), createdAt: daysAgo(0.2) }); // applied
      await mkOrder(tx, user.id, pending.id, { purpose: "renewal", statusCode: 2, createdAt: daysAgo(0.1) }); // failed
      const open = await mkOrder(tx, user.id, pending.id, { purpose: "renewal", orderTrackingId: null, createdAt: daysAgo(0.05) }); // never opened at the provider, still the newest open renewal order
      for (let i = 0; i < 6; i++) await mkOrder(tx, user.id, pending.id, { statusCode: 1, appliedAt: daysAgo(10 + i), createdAt: daysAgo(10 + i), paymentMethod: "MPESA" });
      const s2 = await check("active + open renewal + 12 orders");
      expect(s2.renewalOrder).toMatchObject({ id: open.id });
      expect(s2.payments).toHaveLength(5);

      // S3: past_due behaves like active for the renewal order
      await tx.update(subscriptions).set({ status: "past_due" }).where(eq(subscriptions.id, pending.id));
      const s3 = await check("past_due");
      expect(s3.renewalOrder).toMatchObject({ id: open.id });

      // S4: the live subscription wins over a NEWER terminated one
      await tx.update(subscriptions).set({ createdAt: daysAgo(40) }).where(eq(subscriptions.id, pending.id));
      await mkSub(tx, user.id, { status: "cancelled", plan: "elite", createdAt: daysAgo(2) });
      const s4 = await check("live older than a cancelled one");
      expect(s4.subscription).toMatchObject({ id: pending.id, plan: "pro" });

      // S5: no live subscription: the NEWEST terminated one is shown, and it gets no renewal order
      await tx.update(subscriptions).set({ status: "expired" }).where(eq(subscriptions.id, pending.id));
      await mkSub(tx, user.id, { status: "cancelled", plan: "pro", createdAt: daysAgo(30) });
      const s5 = await check("only terminated subscriptions");
      expect(s5.subscription).toMatchObject({ status: "cancelled", plan: "elite" });
      expect(s5.renewalOrder).toBeNull();

      // S6: admin-granted plan + a ledger row
      await tx.update(users).set({ plan: "elite", planSource: "admin" }).where(eq(users.id, user.id));
      await tx.insert(usageLedger).values({ userId: user.id, month: monthKey(), videosUploaded: 4, metadataGenerated: 3, veoGenerated: 2, aiMessagesUsed: 1 });
      const s6 = await check("admin plan + ledger");
      expect(s6).toMatchObject({ plan: "elite", planSource: "admin", selfServe: false });
      expect(s6.usage.items).toMatchObject({ videosUploaded: { used: 4 }, metadataGenerated: { used: 3 }, veoGenerated: { used: 2 }, aiMessagesUsed: { used: 1 } });

      // a caller without a users row (free, nothing)
      const stranger = randomUUID();
      const oldS = await legacyBuildBillingStatus(tx, stranger, cfg());
      const newS = await buildBillingStatus(tx, stranger, cfg());
      expectSame(newS, oldS);
      expect(newS).toMatchObject({ plan: "free", planSource: "default", subscription: null, payments: [] });
    });
  });

  test("the rpc stays at 4 statements however many payments exist", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const few = await countQueries(() => callRpc("billing.getStatus", {}, { user, tx }));
      for (let i = 0; i < 9; i++) await mkOrder(tx, user.id, null, { statusCode: 1, appliedAt: daysAgo(i + 1), createdAt: daysAgo(i + 1) });
      const many = await countQueries(() => callRpc("billing.getStatus", {}, { user, tx }));
      expect(few.queries).toBe(4);
      expect(many.queries).toBe(4);
      expect((many.result as { payments: unknown[] }).payments).toHaveLength(5);
    });
  });
});

// ─── lib/usage.ts + its rpc callers ──────────────────────────────────────────

describe("usage", () => {
  test("getUsage is one statement and returns what the two-statement version did", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const stranger = randomUUID();
      const states: (() => Promise<unknown>)[] = [
        async () => undefined, // free, no ledger row
        async () => {
          await tx.insert(usageLedger).values({ userId: user.id, month: monthKey(), videosUploaded: 7, aiMessagesUsed: 2 });
        },
        async () => {
          await setPlan(tx, user.id, "pro");
        },
        async () => {
          await setPlan(tx, user.id, "elite");
        },
      ];
      for (const advance of states) {
        await advance();
        const old = await countQueries(() => legacyGetUsage(tx, user.id));
        const now = await countQueries(() => getUsage(tx, user.id));
        expect(old.queries).toBe(2);
        expect(now.queries).toBe(1);
        expectSame(now.result, old.result);
        // with the plan supplied only the ledger is read, same answer
        const known = await countQueries(() => getUsage(tx, user.id, old.result.plan));
        expect(known.queries).toBe(1);
        expectSame(known.result, old.result);
        expect(await getUsageWithPlanSource(tx, user.id)).toMatchObject({ ...old.result, planSource: "default" });
      }
      expectSame(await getUsage(tx, stranger), await legacyGetUsage(tx, stranger)); // no users row: free, zeros
    });
  });

  test("consumeQuota with a known plan skips the users read; limits and errors are unchanged", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const read = await countQueries(() => consumeQuota(tx, user.id, "metadataGenerated"));
      const known = await countQueries(() => consumeQuota(tx, user.id, "metadataGenerated", "free"));
      report(`consumeQuota before=${read.queries} after(with plan)=${known.queries}`);
      expect(read.queries).toBe(2);
      expect(known.queries).toBe(1);
      expect(read.result).toEqual({ used: 1, limit: 5 });
      expect(known.result).toEqual({ used: 2, limit: 5 });

      // free plan has no Veo allowance: refused before any write, with the plan name in the message
      const veo = await countQueries(() => consumeQuota(tx, user.id, "veoGenerated", "free").catch((e: unknown) => e));
      expect(veo.queries).toBe(0);
      expect(veo.result).toMatchObject({ code: "PLAN_LIMIT_EXCEEDED", message: expect.stringContaining("PLAN_LIMIT_EXCEEDED:veoGenerated:free") });

      // the cap itself: 5 metadata units on free, the 6th is refused and nothing is incremented
      for (let i = 0; i < 3; i++) await consumeQuota(tx, user.id, "metadataGenerated", "free");
      await expect(consumeQuota(tx, user.id, "metadataGenerated", "free")).rejects.toMatchObject({ code: "PLAN_LIMIT_EXCEEDED", message: expect.stringContaining("metadataGenerated:free") });
      expect((await getUsage(tx, user.id)).used.metadataGenerated).toBe(5);
      // a higher plan passed in raises the limit in the same statement
      expect(await consumeQuota(tx, user.id, "metadataGenerated", "pro")).toMatchObject({ used: 6, limit: limitsFor("pro").metadataGenerated });
    });
  });

  test("videos.create uses ctx.user.plan (2 statements, was 3); createGenerated still reads the live plan (2, was 3)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const created = await countQueries(() => callRpc("videos.create", { title: "x", rawFileKey: CLOUD, rawFileSize: 1 }, { user, tx }));
      report(`videos.create before=3 after=${created.queries}`);
      expect(created.queries).toBe(2); // ledger upsert + insert
      expect(typeof created.result).toBe("string");

      // createGenerated reads the plan from the DB (a snapshot user must not hide a plan change)
      await setPlan(tx, user.id, "pro");
      const gen = await countQueries(() => callRpc("videos.createGenerated", { title: "g", aiConfig: { prompt: "a cat" } }, { user, tx }));
      report(`videos.createGenerated before=3 after=${gen.queries}`);
      expect(gen.queries).toBe(2); // plan + ledger in one, insert
      expect(typeof gen.result).toBe("string");
    });
  });

  test("usageLedger.getUsageSummary drops from 2 to 1 statement", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const r = await countQueries(() => callRpc("usageLedger.getUsageSummary", {}, { user, tx }));
      report(`usageLedger.getUsageSummary before=2 after=${r.queries}`);
      expect(r.queries).toBe(1);
    });
  });
});

// ─── videos.get ──────────────────────────────────────────────────────────────

describe("videos.get", () => {
  test("two concurrent statements whatever the history size; captions kept; nothing leaks to other users", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const v = await insertVideo(tx, user.id, { title: "mine", captionsVtt: "WEBVTT\n\n00:00.000 --> 00:01.000\nhello" });
      type Got = { captionsVtt?: string; title: string; metadataHistory?: { aiTitle?: string; savedAt: number }[] };
      const empty = await countQueries(() => callRpc("videos.get", { id: v.id }, { user, tx }));
      report(`videos.get 0-history before=2 after=${empty.queries} (concurrent)`);
      expect(empty.queries).toBe(2);
      expect((empty.result as Got).captionsVtt).toContain("WEBVTT");
      expect((empty.result as Got).metadataHistory ?? []).toEqual([]);

      await tx.insert(videoMetadataVersions).values(Array.from({ length: 14 }, (_, i) => ({ videoId: v.id, aiTitle: `t${i}`, savedAt: new Date(Date.now() - (14 - i) * 1000) })));
      const full = await countQueries(() => callRpc("videos.get", { id: v.id }, { user, tx }));
      expect(full.queries).toBe(2);
      const got = full.result as Got;
      expect(got.metadataHistory).toHaveLength(10);
      expect(got.metadataHistory!.map((h) => h.aiTitle)).toEqual(Array.from({ length: 10 }, (_, i) => `t${13 - i}`)); // newest first
      expect(got.metadataHistory).toEqual((await listMetadataHistory(tx, v.id)).map((h) => toWire(h)) as never);

      // someone else's video id: null, and none of its history is returned
      const stranger = await makeUser();
      expect(await callRpc("videos.get", { id: v.id }, { user: stranger, tx })).toBeNull();
      // a malformed id never reaches the database
      const bad = await countQueries(() => callRpc("videos.get", { id: "not-a-uuid" }, { user, tx }));
      expect(bad.result).toBeNull();
      expect(bad.queries).toBe(0);
    });
  });
});

// ─── queue stats + settings.get ──────────────────────────────────────────────

describe("queue.getQueueStats", () => {
  test("one statement (was 2) with the same answer in every state", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const stranger = await makeUser();
      const check = async (label: string) => {
        const old = await countQueries(() => legacyQueueStats(tx, user.id));
        const now = await countQueries(() => callRpc("queue.getQueueStats", {}, { user, tx }));
        report(`queue.getQueueStats [${label}] before=${old.queries} after=${now.queries}`);
        expect(old.queries).toBe(2);
        expect(now.queries).toBe(1);
        expect(JSON.stringify(now.result)).toBe(JSON.stringify(toWire(old.result))); // wire form: epoch ms, null omitted, same key order
        return now.result as { readyCount: number; scheduledCount: number; nextPublishAt?: number };
      };

      expect(await check("nothing")).toEqual({ readyCount: 0, scheduledCount: 0 });

      await insertVideo(tx, user.id, { status: "ready" });
      await insertVideo(tx, user.id, { status: "ready" });
      await insertVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: new Date(Date.now() + DAY) });
      await insertVideo(tx, user.id, { status: "draft" });
      await insertVideo(tx, stranger.id, { status: "ready" });
      expect(await check("videos, no settings row")).toEqual({ readyCount: 2, scheduledCount: 1 });

      await putSettings(tx, user.id, {});
      expect(await check("settings row without a next time")).toEqual({ readyCount: 2, scheduledCount: 1 });

      const next = new Date("2031-05-06T07:08:09.123Z");
      await putSettings(tx, user.id, { autoPublishNextAt: next });
      expect(await check("settings with a next time")).toEqual({ readyCount: 2, scheduledCount: 1, nextPublishAt: next.getTime() });

      // no videos at all but a next time still reports it
      await tx.execute(sql`delete from videos where user_id = ${user.id}`);
      expect(await check("settings only")).toEqual({ readyCount: 0, scheduledCount: 0, nextPublishAt: next.getTime() });
    });
  });
});

describe("settings.get", () => {
  test("the settings row and the channel summary are fetched together (2 statements)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await putSettings(tx, user.id, { aiTone: "casual" });
      const r = await countQueries(() => callRpc("settings.get", {}, { user, tx }));
      report(`settings.get before=2 after=${r.queries} (concurrent)`);
      expect(r.queries).toBe(2);
      expect(r.result).toMatchObject({ aiTone: "casual", youtubeConnected: false });
    });
  });
});

// ─── dashboard stats, channel totals, suggested times ────────────────────────

describe("analytics reads", () => {
  test("getDashboardStats: one statement (was 2), identical result", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const check = async (label: string) => {
        const old = await countQueries(() => legacyDashboardStats(tx, user.id));
        const now = await countQueries(() => getDashboardStats(tx, user.id));
        report(`getDashboardStats [${label}] before=${old.queries} after=${now.queries}`);
        expect(old.queries).toBe(2);
        expect(now.queries).toBe(1);
        expectSame(now.result, old.result);
        return now.result;
      };
      const empty = await check("no videos");
      expect(empty).toMatchObject({ statusData: [], totalVideos: 0 });
      expect(empty.timelineData).toHaveLength(7);

      const today = Math.floor(Date.now() / DAY) * DAY;
      const at = (d: number, h = 12) => new Date(today - d * DAY + h * 3_600_000);
      await insertVideo(tx, user.id, { status: "published", rawFileSize: 10, duration: 60, createdAt: at(6, 0) });
      await insertVideo(tx, user.id, { status: "ready", rawFileSize: 5_000_000_000, createdAt: at(4) });
      await insertVideo(tx, user.id, { status: "draft", rawFileSize: 1000, duration: 30, createdAt: at(1) });
      await insertVideo(tx, user.id, { status: "draft", rawFileSize: 2000, duration: 45.5, createdAt: at(0, 1) });
      await insertVideo(tx, user.id, { status: "failed", rawFileSize: 5, createdAt: at(9) }); // outside the 7-day window
      await insertVideo(tx, (await makeUser()).id, { status: "draft", rawFileSize: 999 });
      const full = await check("mixed statuses");
      expect(full.statusData.map((s) => s.name)).toEqual(["Failed", "Published", "Ready", "Draft"]); // ordered by first upload
      expect(full.totalVideos).toBe(5);
    });
  });

  test("getChannelTotals: one statement (was 2), identical result for 0, 1 and 8 videos", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const check = async (label: string) => {
        const old = await countQueries(() => legacyChannelTotals(tx, user.id));
        const now = await countQueries(() => getChannelTotals(tx, user.id));
        report(`getChannelTotals [${label}] before=${old.queries} after=${now.queries}`);
        expect(old.queries).toBe(2);
        expect(now.queries).toBe(1);
        expectSame(now.result, old.result);
        return now.result;
      };
      const none = await check("no videos");
      expect(none).toEqual({ totalViews: 0, totalWatchTimeMinutes: 0, totalImpressions: 0, avgCtr: null, topVideos: [] });
      expect(toWire(none)).not.toHaveProperty("avgCtr");

      type Snap = { day: string; fetchedAt: Date; views: number | null; ctr?: number | null; watch?: number; imp?: number };
      const mk = async (i: number, snaps: Snap[]) => {
        const v = await insertVideo(tx, user.id, { status: "published", publishedVideoId: `yt${i}` });
        for (const s of snaps) {
          await tx
            .insert(videoAnalytics)
            .values({ userId: user.id, videoId: v.id, youtubeVideoId: `yt${i}`, day: s.day, fetchedAt: s.fetchedAt, views: s.views, ctr: s.ctr ?? null, watchTimeMinutes: s.watch ?? null, impressions: s.imp ?? null });
        }
        return v;
      };
      const snap = (day: string, views: number | null, extra: Partial<Snap> = {}): Snap => ({ day, fetchedAt: new Date(`${day}T00:00:00Z`), views, ...extra });

      await mk(1, [snap("2026-01-01", 5), snap("2026-01-02", 100, { watch: 12.5, imp: 1000 })]); // the older snapshot is superseded
      const few = await check("one video, no ctr");
      expect(few.avgCtr).toBeNull();
      expect(few.totalViews).toBe(100);

      // more videos than the 5 shown, distinct view counts, some null columns, an older snapshot with a bigger number
      await mk(2, [snap("2026-01-02", 900, { ctr: 0.05, watch: 1.5, imp: 20 })]);
      await mk(3, [snap("2026-01-03", 300, { ctr: 0.1 })]);
      await mk(4, [snap("2026-01-04", 700, { imp: 5 }), snap("2026-01-03", 99999)]);
      await mk(5, [snap("2026-01-05", 500, { ctr: 0.2, watch: 3 })]);
      await mk(6, [snap("2026-01-06", 200)]);
      await mk(7, [snap("2026-01-07", 800, { ctr: 0.0 })]);
      await mk(8, [snap("2026-01-08", null)]); // null views sort last
      const other = await makeUser();
      const mine = await insertVideo(tx, user.id);
      await tx.insert(videoAnalytics).values({ userId: other.id, videoId: mine.id, youtubeVideoId: "x", day: "2026-01-09", views: 123456 }); // another user's row: ignored
      const many = await check("8 videos");
      expect(many.topVideos.map((t) => t.views)).toEqual([900, 800, 700, 500, 300]);
      expect(many.totalViews).toBe(100 + 900 + 300 + 700 + 500 + 200 + 800);
      expect(many.avgCtr).toBeCloseTo((0.05 + 0.1 + 0.2 + 0.0) / 4, 10);
    });
  });

  test("computeSuggestedTimes: one statement (was 1-2), same answer below, at and above the 5-video threshold", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const check = async (label: string, expectedBefore: number) => {
        const old = await countQueries(() => legacySuggestedTimes(tx, user.id));
        const now = await countQueries(() => computeSuggestedTimes(tx, user.id));
        report(`computeSuggestedTimes [${label}] before=${old.queries} after=${now.queries}`);
        expect(old.queries).toBe(expectedBefore);
        expect(now.queries).toBe(1);
        expectSame(now.result, old.result);
        return now.result;
      };
      const mk = async (hour: number, analysed: boolean, status: "published" | "ready" = "published", uid = user.id) => {
        const v = await insertVideo(tx, uid, { status, publishedVideoId: status === "published" ? `yt${randomUUID()}` : null, publishedAt: new Date(Date.UTC(2026, 0, 10, hour, 30)) });
        if (analysed) await tx.insert(videoAnalytics).values({ userId: uid, videoId: v.id, youtubeVideoId: "yt", day: "2026-01-11", views: 100 + hour, ctr: 0.01 * hour });
        return v;
      };

      expect(await check("no videos", 1)).toMatchObject({ reason: "not_enough_data", videosNeeded: 5 });
      for (const h of [1, 2, 3]) await mk(h, true);
      expect(await check("3 published", 1)).toMatchObject({ reason: "not_enough_data" });

      // 6 published but only 4 analysed: still not enough (the old count said "enough", the scorer said no)
      await mk(4, true);
      await mk(5, false);
      await mk(6, false);
      await mk(7, true, "ready"); // not published
      await mk(8, true, "published", (await makeUser()).id); // someone else's
      expect(await check("6 published, 4 analysed", 2)).toMatchObject({ reason: "not_enough_data" });

      await mk(5, true); // the fifth analysed video
      expect(await check("7 published, 5 analysed", 2)).toMatchObject({ reason: "analytics", totalVideosAnalysed: 5 });
    });
  });
});

// ─── AI actions ──────────────────────────────────────────────────────────────

describe("AI actions", () => {
  test("aiAssistant.chat: settings are read once, the plan is reused (12 -> 9 statements with the user's key, 13 -> 10 with the platform key)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      const pro = { ...user, plan: "pro" as const };
      await setPlatformKeys(tx, { deepseek: "sk-platform-key-0123456789" });
      await mkVideo(tx, user.id, { title: "Pasta tips", status: "published" });
      const [s] = await tx.insert(aiSessions).values({ userId: user.id, title: "t" }).returning();
      handler = (url) => (url.includes("api.deepseek.com") ? json({ choices: [{ message: { content: "ok" } }] }) : new Response("", { status: 404 }));

      // session not found: one statement (as before), nothing else touched
      const nf = await countQueries(() => callRpc("actions.aiAssistant.chat", { message: "hi", sessionId: randomUUID() }, { user: pro, tx }).catch((e: unknown) => e));
      expect(nf.result).toMatchObject({ code: "NOT_FOUND" });
      expect(nf.queries).toBe(1);

      // no key anywhere: session+settings, platform key; not metered
      await putSettings(tx, user.id, {});
      await setPlatformKeys(tx, { deepseek: null });
      const nokey = await countQueries(() => callRpc("actions.aiAssistant.chat", { message: "hi", sessionId: s.id }, { user: pro, tx }));
      expect(nokey.result).toEqual({ error: "no_api_key" });
      expect(nokey.queries).toBe(2);

      await putSettings(tx, user.id, { deepseekApiKey: encryptSecret("sk-own-key-0123456789abcdef"), aiNiche: "cooking" });
      await setPlatformKeys(tx, { deepseek: "sk-platform-key-0123456789" });
      const own = await countQueries(() => callRpc("actions.aiAssistant.chat", { message: "hi", sessionId: s.id }, { user: pro, tx }));
      report(`aiAssistant.chat own-key before=12 after=${own.queries}`);
      expect(own.result).toEqual({ response: "ok" });
      expect(own.queries).toBeLessThanOrEqual(9); // was 12; a few of these statements live in helpers outside this module
      const sent = JSON.parse(String(net.calls[0].init!.body)) as { messages: { role: string; content: string }[] };
      expect(sent.messages[0].content).toContain("cooking"); // the prompt still sees the settings row
      expect(sent.messages[0].content).toContain("Pasta tips");

      await putSettings(tx, user.id, {});
      const platform = await countQueries(() => callRpc("actions.aiAssistant.chat", { message: "hi", sessionId: s.id }, { user: pro, tx }));
      report(`aiAssistant.chat platform-key before=13 after=${platform.queries}`);
      expect(platform.result).toEqual({ response: "ok" });
      expect(platform.queries).toBeLessThanOrEqual(10); // was 13
      const sent2 = JSON.parse(String(net.calls[1].init!.body)) as { messages: { content: string }[] };
      expect(sent2.messages[0].content).not.toContain("cooking");
    });
  });

  test("metadata.generateForUpload: plan reused and no full video row (10 -> 9 statements)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: "gem-key" });
      await putSettings(tx, user.id, {});
      const v = await mkVideo(tx, user.id, { rawFileKey: CLOUD, status: "draft", captionsVtt: "WEBVTT\n".repeat(2000) });
      handler = (url) => {
        if (url.includes(":generateContent")) return geminiText(META_JSON);
        if (url.includes("res.cloudinary.com")) return new Response(new Uint8Array([0xff, 0xd8]), { status: 200 });
        return new Response("", { status: 404 });
      };
      const r = await countQueries(() => callRpc("actions.metadata.generateForUpload", { videoId: v.id }, { user, tx }));
      report(`metadata.generateForUpload before=10 after=${r.queries}`);
      expect(r.result).toEqual({ title: "Generated Title", description: "Generated description.", tags: ["a", "b"] });
      expect(r.queries).toBeLessThanOrEqual(9); // was 10; the Gemini key / settings re-reads live in generation/metadataRuns.ts
      // the first statement is the video lookup: it must not select the transcript column
      expect(r.statements[0]).toContain('from "videos"');
      expect(r.statements[0]).not.toContain("captions_vtt");
    });
  });
});
