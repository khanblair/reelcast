/**
 * Statement-count and equivalence tests for the admin console reads.
 *
 * Every SQL statement is a network round trip, so each admin read must cost a small CONSTANT number of statements
 * (asserted with countQueries), and the answer must be exactly what the earlier, slower implementation returned. The
 * "legacy" functions below are verbatim copies of that earlier code: the RPC output must equal theirs after the same
 * wire conversion (toWire), so these tests prove the rewrite changed the number of round trips and nothing else.
 *
 * The database is shared with other suites that commit rows, so a comparison that reads global tables is retried a few
 * times if a foreign commit lands between the two reads.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { jobs, paymentEvents, paymentOrders, settings, subscriptions, SUBSCRIPTION_STATUSES, users, videos, youtubeChannels } from "@/db/schema";
import { getChannelSummary } from "@/server/lib/dto";
import { countQueries } from "@/server/testing";
import type { UserRow } from "../../rpc/define";
import { toWire } from "../../rpc/wire";
import { callRpc, inRolledBackTx } from "../../testing";

setDefaultTimeout(120_000);

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const asAdmin = (u: UserRow): UserRow => ({ ...u, isAdmin: true });

/** Compares labelled strings so a failure says which statement count regressed. */
function expectCount(label: string, got: number, want: number) {
  expect(`${label}=${got}`).toBe(`${label}=${want}`);
}

/** Run `read` until `same` accepts it (a foreign commit between two reads of a shared table can differ once). */
async function settle<T>(read: () => Promise<T>, same: (r: T) => boolean): Promise<T> {
  let r!: T;
  for (let attempt = 0; attempt < 4; attempt++) {
    r = await read();
    if (same(r)) break;
  }
  return r;
}

/** settings is unique per user and other suites may have committed a row: upsert. */
async function upsertSettings(tx: DbLike, userId: string, values: Partial<typeof settings.$inferInsert>) {
  await tx.insert(settings).values({ userId, ...values }).onConflictDoUpdate({ target: settings.userId, set: values });
}

// ─── legacy implementations (the code these tests guard against regressing) ─────────────────────────────────────

async function legacyStats(db: DbLike) {
  const startOfTodayUtc = new Date();
  startOfTodayUtc.setUTCHours(0, 0, 0, 0);
  const last24h = new Date(Date.now() - 86_400_000);
  const [userAgg, channelAgg, videoAgg, jobAgg, publishAgg, settingsAgg] = await Promise.all([
    db.select({ total: count(), admins: sql<number>`count(*) filter (where ${users.isAdmin})`.mapWith(Number) }).from(users),
    db.select({ connected: count() }).from(youtubeChannels).where(eq(youtubeChannels.isPrimary, true)),
    db
      .select({
        total: count(),
        published: sql<number>`count(*) filter (where ${videos.status} = 'published')`.mapWith(Number),
        bytes: sql<number>`coalesce(sum(${videos.rawFileSize}), 0)`.mapWith(Number),
      })
      .from(videos),
    db.select({ today: count() }).from(jobs).where(gte(jobs.startedAt, startOfTodayUtc)),
    db
      .select({ total: count(), ok: sql<number>`count(*) filter (where ${jobs.status} = 'completed')`.mapWith(Number) })
      .from(jobs)
      .where(and(eq(jobs.type, "publish"), isNotNull(jobs.completedAt), gte(jobs.completedAt, last24h))),
    db.select({ active: count() }).from(settings).where(eq(settings.autoPublishEnabled, true)),
  ]);
  const finished = publishAgg[0].total;
  return {
    totalUsers: userAgg[0].total,
    youtubeConnected: channelAgg[0].connected,
    adminCount: userAgg[0].admins,
    totalVideos: videoAgg[0].total,
    publishedVideos: videoAgg[0].published,
    totalStorageBytes: videoAgg[0].bytes,
    jobsToday: jobAgg[0].today,
    successRate24h: finished > 0 ? publishAgg[0].ok / finished : null,
    autoPublishActive: settingsAgg[0].active,
  };
}

const FLAGGED_SQL = sql`(${paymentOrders.statusText} in ('AMOUNT_MISMATCH', 'STALE_UPGRADE') or ${paymentOrders.statusCode} = 3)`;

async function legacyOverview(db: DbLike) {
  const [subs, revenue, review, pending] = await Promise.all([
    db
      .select({ status: subscriptions.status, n: sql<number>`count(*)`.mapWith(Number) })
      .from(subscriptions)
      .groupBy(subscriptions.status),
    db
      .select({
        currency: paymentOrders.currency,
        total: sql<string>`coalesce(sum(${paymentOrders.amount}), 0)`,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(paymentOrders)
      .where(and(eq(paymentOrders.statusCode, 1), isNotNull(paymentOrders.appliedAt), sql`${paymentOrders.appliedAt} > now() - interval '30 days'`))
      .groupBy(paymentOrders.currency),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(paymentOrders)
      .where(and(isNull(paymentOrders.reviewedAt), FLAGGED_SQL)),
    db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(paymentOrders)
      .where(and(or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0)), isNotNull(paymentOrders.orderTrackingId), sql`${paymentOrders.createdAt} > now() - interval '7 days'`)),
  ]);
  const byStatus = Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, subs.find((r) => r.status === s)?.n ?? 0])) as Record<(typeof SUBSCRIPTION_STATUSES)[number], number>;
  return {
    subscriptions: {
      active: byStatus.active,
      pastDue: byStatus.past_due,
      awaitingPayment: byStatus.approval_pending,
      cancelled: byStatus.cancelled,
      expired: byStatus.expired,
    },
    revenue30d: revenue.map((r) => ({ currency: r.currency, total: Number(r.total), count: r.count })),
    needsReviewCount: review[0]?.n ?? 0,
    pendingPayments: pending[0]?.n ?? 0,
  };
}

/** The notification trail of an order, found the way the first implementation did (two dependent statements). */
async function legacyEvents(db: DbLike, orderId: string) {
  const [o] = await db.select({ orderTrackingId: paymentOrders.orderTrackingId, merchantRef: paymentOrders.merchantRef }).from(paymentOrders).where(eq(paymentOrders.id, orderId)).limit(1);
  if (!o) return null;
  const keys = [o.orderTrackingId, o.merchantRef].filter((k): k is string => !!k);
  return keys.length
    ? await db
        .select({
          id: paymentEvents.id,
          notificationType: paymentEvents.notificationType,
          receivedAt: paymentEvents.receivedAt,
          processedAt: paymentEvents.processedAt,
          error: paymentEvents.error,
        })
        .from(paymentEvents)
        .where(or(inArray(paymentEvents.orderTrackingId, keys), inArray(paymentEvents.merchantRef, keys)))
        .orderBy(desc(paymentEvents.receivedAt))
        .limit(50)
    : [];
}

const has = (col: unknown) => sql<boolean>`coalesce(${col}, '') <> ''`;

async function legacyDetails(db: DbLike, userId: string) {
  const [u] = await db
    .select({
      id: users.id,
      createdAt: users.createdAt,
      email: users.email,
      name: users.name,
      imageUrl: users.imageUrl,
      plan: users.plan,
      planSource: users.planSource,
      isAdmin: users.isAdmin,
      autoPublishEnabled: sql<boolean>`coalesce(${settings.autoPublishEnabled}, false)`,
      hasDiscordWebhook: has(settings.discordWebhookUrl),
      hasTelegram: has(settings.telegramChatId),
      hasResendApiKey: has(settings.resendApiKey),
      hasDeepseekApiKey: has(settings.deepseekApiKey),
    })
    .from(users)
    .leftJoin(settings, eq(settings.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return null;
  const user = { ...u, ...(await getChannelSummary(db, userId)) };
  const [videoRows, [videoTotal], recentJobs] = await Promise.all([
    db
      .select({
        id: videos.id,
        createdAt: videos.createdAt,
        title: videos.title,
        status: videos.status,
        publishedAt: videos.publishedAt,
        scheduledPublishAt: videos.scheduledPublishAt,
        rawFileSize: videos.rawFileSize,
      })
      .from(videos)
      .where(eq(videos.userId, userId))
      .orderBy(desc(videos.createdAt))
      .limit(200),
    db.select({ n: count() }).from(videos).where(eq(videos.userId, userId)),
    db
      .select({
        id: jobs.id,
        createdAt: jobs.createdAt,
        type: jobs.type,
        status: jobs.status,
        error: jobs.error,
        startedAt: jobs.startedAt,
        completedAt: jobs.completedAt,
      })
      .from(jobs)
      .where(eq(jobs.userId, userId))
      .orderBy(desc(jobs.createdAt))
      .limit(20),
  ]);
  return { user, videos: videoRows, videoCount: videoTotal.n, recentJobs };
}

async function legacyStorageHealth(db: DbLike) {
  const relevant = inArray(videos.status, ["ready", "scheduled"]);
  const [agg] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      missing: sql<number>`count(*) filter (where ${videos.storageMissing} is true)`.mapWith(Number),
      healthy: sql<number>`count(*) filter (where ${videos.storageMissing} is false)`.mapWith(Number),
    })
    .from(videos)
    .where(relevant);
  const missingVideos = await db
    .select({
      videoId: videos.id,
      aiTitle: videos.aiTitle,
      title: videos.title,
      userEmail: users.email,
      status: videos.status,
      checkedAt: videos.storageCheckedAt,
    })
    .from(videos)
    .leftJoin(users, eq(users.id, videos.userId))
    .where(and(relevant, eq(videos.storageMissing, true)))
    .orderBy(sql`${videos.storageCheckedAt} desc nulls last`)
    .limit(200);
  return {
    totalRelevant: agg.total,
    healthyCount: agg.healthy,
    missingCount: agg.missing,
    uncheckedCount: agg.total - agg.missing - agg.healthy,
    missingVideos: missingVideos.map((v) => ({
      videoId: v.videoId,
      title: v.aiTitle ?? v.title,
      userEmail: v.userEmail ?? "unknown",
      status: v.status,
      checkedAt: v.checkedAt,
    })),
  };
}

// ─── stats ───────────────────────────────────────────────────────────────────

describe("admin.stats.getStats", () => {
  test("is ONE statement and returns exactly what the six-statement version returned", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const other = await makeUser();
      await upsertSettings(tx, other.id, { autoPublishEnabled: true });
      const [v1, v2] = await tx
        .insert(videos)
        .values([
          { userId: other.id, title: "p", rawFileKey: "k1", rawFileSize: 5_000_000_000, status: "published", publishedVideoId: "yt1" },
          { userId: other.id, title: "r", rawFileKey: "k2", rawFileSize: 7, status: "ready" },
        ])
        .returning();
      const now = new Date();
      await tx.insert(jobs).values([
        { userId: other.id, videoId: v1.id, type: "publish", status: "completed", startedAt: now, completedAt: now },
        { userId: other.id, videoId: v2.id, type: "publish", status: "failed", error: "x", startedAt: now, completedAt: now },
        { userId: other.id, videoId: v2.id, type: "publish", status: "completed", startedAt: ago(3), completedAt: ago(3) }, // finished too long ago
        { userId: other.id, videoId: v2.id, type: "generation", status: "completed", startedAt: now, completedAt: now }, // not a publish job
      ]);

      const run = await countQueries(() => callRpc("admin.stats.getStats", {}, { user: admin, tx }));
      expectCount("stats.getStats statements", run.queries, 1);

      const { got, want } = await settle(
        async () => ({ got: await callRpc("admin.stats.getStats", {}, { user: admin, tx }), want: toWire(await legacyStats(tx)) }),
        (r) => JSON.stringify(r.got) === JSON.stringify(r.want),
      );
      expect(got).toEqual(want as never);
      const s = got as { totalStorageBytes: number; successRate24h?: number; publishedVideos: number };
      expect(s.totalStorageBytes).toBeGreaterThanOrEqual(5_000_000_007); // a bigint sum beyond int4, returned as a number
      expect(typeof s.successRate24h).toBe("number");
      expect(typeof s.publishedVideos).toBe("number");
    });
  });
});

// ─── billing overview ────────────────────────────────────────────────────────

describe("admin.billing.overview", () => {
  test("is TWO statements and returns exactly what the four-statement version returned", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const people = [await makeUser(), await makeUser(), await makeUser(), await makeUser(), await makeUser()];
      await tx.insert(subscriptions).values(SUBSCRIPTION_STATUSES.map((status, i) => ({ userId: people[i].id, plan: "pro" as const, status })));
      const pay = (over: Partial<typeof paymentOrders.$inferInsert>) =>
        tx.insert(paymentOrders).values({ userId: people[0].id, merchantRef: `t_${randomUUID()}`, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD", statusCode: 1, appliedAt: ago(1), ...over });
      await pay({ amount: "19.00", appliedAt: ago(2) });
      await pay({ amount: "10.55", appliedAt: ago(5) });
      await pay({ amount: "500.00", currency: "KES", appliedAt: ago(3) });
      await pay({ amount: "99.00", appliedAt: ago(40) }); // too old for revenue
      await pay({ statusText: "AMOUNT_MISMATCH", appliedAt: null }); // needs review
      await pay({ statusText: "STALE_UPGRADE", appliedAt: null, reviewedAt: new Date() }); // reviewed
      await pay({ statusCode: 3, statusText: "REVERSED", appliedAt: null });
      await pay({ statusCode: null, appliedAt: null, orderTrackingId: `trk-${randomUUID()}` }); // pending
      await pay({ statusCode: 0, appliedAt: null, orderTrackingId: `trk-${randomUUID()}`, createdAt: ago(9) }); // pending but too old
      await pay({ statusCode: 0, appliedAt: null }); // never sent to Pesapal

      const run = await countQueries(() => callRpc("admin.billing.overview", {}, { user: admin, tx }));
      expectCount("billing.overview statements", run.queries, 2);

      const byCurrency = (o: { revenue30d?: { currency: string }[] }) => [...(o.revenue30d ?? [])].sort((a, b) => a.currency.localeCompare(b.currency));
      const { got, want } = await settle(
        async () => ({ got: (await callRpc("admin.billing.overview", {}, { user: admin, tx })) as { revenue30d?: { currency: string }[] }, want: toWire(await legacyOverview(tx)) as { revenue30d?: { currency: string }[] } }),
        (r) => JSON.stringify({ ...r.got, revenue30d: byCurrency(r.got) }) === JSON.stringify({ ...r.want, revenue30d: byCurrency(r.want) }),
      );
      // (group order is unspecified in both versions, so the per-currency rows are compared sorted)
      expect({ ...got, revenue30d: byCurrency(got) }).toEqual({ ...want, revenue30d: byCurrency(want) } as never);
      const o = got as unknown as { subscriptions: Record<string, number>; needsReviewCount: number; pendingPayments: number; revenue30d: { currency: string; total: number; count: number }[] };
      expect(Object.values(o.subscriptions).every((n) => typeof n === "number")).toBe(true);
      expect(o.needsReviewCount).toBeGreaterThanOrEqual(2);
      expect(o.pendingPayments).toBeGreaterThanOrEqual(1);
      expect(o.revenue30d.find((r) => r.currency === "KES")!.total).toBeGreaterThanOrEqual(500);
    });
  });
});

// ─── payments: projection + notification trail ───────────────────────────────

describe("admin.billing payments", () => {
  test("the payment lists, needs-review queue, detail and per-user views never select the checkout link, and return the same DTO", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const u = await makeUser({ name: "Pat Payer" });
      const [sub] = await tx.insert(subscriptions).values({ userId: u.id, plan: "pro", status: "active" }).returning();
      const [o] = await tx
        .insert(paymentOrders)
        .values({
          userId: u.id,
          subscriptionId: sub.id,
          merchantRef: `t_${randomUUID()}`,
          orderTrackingId: `trk-${randomUUID()}`,
          purpose: "renewal",
          plan: "pro",
          amount: "12.34",
          currency: "USD",
          statusCode: 1,
          statusText: "AMOUNT_MISMATCH",
          confirmationCode: "CONF-1",
          paymentMethod: "MPESA",
          redirectUrl: "https://pay.example/checkout/secret-token",
          appliedAt: ago(1),
          reviewedAt: ago(0.5),
          reviewedBy: admin.id,
          reviewNote: "refunded",
        })
        .returning();

      // Everything the DTO exposes, spelled out from the stored row (nulls are omitted on the wire).
      const expected = toWire({
        id: o.id,
        userId: u.id,
        email: u.email,
        name: "Pat Payer",
        subscriptionId: sub.id,
        merchantRef: o.merchantRef,
        orderTrackingId: o.orderTrackingId,
        confirmationCode: "CONF-1",
        purpose: "renewal",
        plan: "pro",
        amount: 12.34,
        currency: "USD",
        statusCode: 1,
        statusText: "AMOUNT_MISMATCH",
        paymentMethod: "MPESA",
        appliedAt: o.appliedAt,
        flag: "amount_mismatch",
        flagLabel: "Amount mismatch",
        reviewedAt: o.reviewedAt,
        reviewedByEmail: admin.email,
        reviewNote: "refunded",
        createdAt: o.createdAt,
      }) as Record<string, unknown>;
      const dtoOf = (row: Record<string, unknown>) => {
        const { guidance, ...rest } = row;
        expect(String(guidance)).toContain("Pesapal");
        return rest;
      };

      const list = await countQueries(() => callRpc("admin.billing.listPayments", { search: u.email }, { user: admin, tx }));
      const queue = await countQueries(() => callRpc("admin.billing.listNeedsReview", { includeReviewed: true }, { user: admin, tx }));
      const one = await countQueries(() => callRpc("admin.billing.getPayment", { id: o.id }, { user: admin, tx }));
      const per = await countQueries(() => callRpc("admin.billing.forUser", { userId: u.id }, { user: admin, tx }));
      expectCount("billing.listPayments statements", list.queries, 2);
      expectCount("billing.listNeedsReview statements", queue.queries, 2);
      expectCount("billing.getPayment statements", one.queries, 1);
      expectCount("billing.forUser statements", per.queries, 2);

      expect(dtoOf((list.result as { rows: Record<string, unknown>[] }).rows[0])).toEqual(expected);
      expect(dtoOf((queue.result as { rows: Record<string, unknown>[] }).rows.find((r) => r._id === o.id)!)).toEqual(expected);
      expect(dtoOf((one.result as { payment: Record<string, unknown> }).payment)).toEqual(expected);
      expect(dtoOf((per.result as { payments: Record<string, unknown>[] }).payments[0])).toEqual(expected);
      for (const run of [list, queue, one, per]) {
        expect(JSON.stringify(run.result)).not.toContain("secret-token");
        // the checkout link, provider, updated_at and reviewed_by are not even selected (the join may still use reviewed_by)
        for (const st of run.statements) {
          const selected = st.slice(0, st.indexOf(" from "));
          for (const col of ["redirect_url", "provider", "updated_at", "reviewed_by"]) expect(`${col}: ${selected.includes(`"${col}"`)}`).toBe(`${col}: false`);
        }
      }
    });
  });

  test("getPayment's notification trail is exactly the old one (both columns against both keys, newest first, 50 max), in ONE statement", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const u = await makeUser();
      const tracking = `trk-${randomUUID().slice(0, 8)}`;
      const ref = `ref_${randomUUID().slice(0, 8)}`;
      const [o] = await tx.insert(paymentOrders).values({ userId: u.id, merchantRef: ref, orderTrackingId: tracking, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" }).returning();
      const [bare] = await tx.insert(paymentOrders).values({ userId: u.id, merchantRef: `bare_${randomUUID().slice(0, 8)}`, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" }).returning();
      let t = Date.now() - 10 * 60_000;
      const at = () => new Date((t += 1000));
      const ev = (over: Partial<typeof paymentEvents.$inferInsert>) => ({ notificationType: "IPNCHANGE", payload: { secret: "raw" }, receivedAt: at(), ...over });
      await tx.insert(paymentEvents).values([
        ev({ orderTrackingId: tracking }), // by tracking id
        ev({ merchantRef: ref }), // by merchant reference
        ev({ orderTrackingId: ref }), // the tracking-id column holding the merchant reference
        ev({ merchantRef: tracking }), // the merchant-reference column holding the tracking id
        ev({ orderTrackingId: tracking, merchantRef: "something-else", error: "boom", processedAt: new Date() }),
        ev({ orderTrackingId: "unrelated-1" }),
        ev({ merchantRef: "unrelated-2" }),
        ev({}), // neither column set
        // events that exist only for the order WITHOUT a tracking id must not leak into the other order's trail
        ev({ merchantRef: bare.merchantRef }),
      ]);

      const run = await countQueries(() => callRpc("admin.billing.getPayment", { id: o.id }, { user: admin, tx }));
      expectCount("billing.getPayment statements", run.queries, 1);
      const events = (run.result as { events: unknown[] }).events;
      expect(events).toHaveLength(5);
      expect(events).toEqual(toWire(await legacyEvents(tx, o.id)) as never);
      const barely = (await callRpc("admin.billing.getPayment", { id: bare.id }, { user: admin, tx })) as { events: unknown[] };
      expect(barely.events).toEqual(toWire(await legacyEvents(tx, bare.id)) as never);
      expect(barely.events).toHaveLength(1);

      // an order with no events at all: an empty trail, not an error
      const [quiet] = await tx.insert(paymentOrders).values({ userId: u.id, merchantRef: `quiet_${randomUUID().slice(0, 8)}`, orderTrackingId: `qt-${randomUUID().slice(0, 8)}`, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" }).returning();
      const q = (await callRpc("admin.billing.getPayment", { id: quiet.id }, { user: admin, tx })) as { payment: { _id: string }; events: unknown[] };
      expect(q.payment._id).toBe(quiet.id);
      expect(q.events).toEqual([]);

      // an unknown id is still null, and costs one statement
      const missing = await countQueries(() => callRpc("admin.billing.getPayment", { id: randomUUID() }, { user: admin, tx }));
      expect(missing.result).toBeNull();
      expectCount("billing.getPayment (unknown id) statements", missing.queries, 1);
    });
  });

  test("a long trail is capped at the 50 newest events, in the same order as before", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const u = await makeUser();
      const tracking = `trk-${randomUUID().slice(0, 8)}`;
      const ref = `ref_${randomUUID().slice(0, 8)}`;
      const [o] = await tx.insert(paymentOrders).values({ userId: u.id, merchantRef: ref, orderTrackingId: tracking, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" }).returning();
      const base = Date.now() - 3_600_000;
      await tx.insert(paymentEvents).values(
        Array.from({ length: 60 }, (_, i) => ({
          notificationType: `E${i}`,
          payload: {},
          receivedAt: new Date(base + i * 1000),
          ...(i % 3 === 0 ? { orderTrackingId: tracking } : i % 3 === 1 ? { merchantRef: ref } : { orderTrackingId: ref }),
        })),
      );
      const r = (await callRpc("admin.billing.getPayment", { id: o.id }, { user: admin, tx })) as { events: { _id: string; notificationType: string }[] };
      expect(r.events).toHaveLength(50);
      expect(r.events.map((e) => e.notificationType)).toEqual(Array.from({ length: 50 }, (_, i) => `E${59 - i}`)); // newest first
      expect(r.events).toEqual(toWire(await legacyEvents(tx, o.id)) as never);
    });
  });
});

// ─── users.getWithDetails ────────────────────────────────────────────────────

describe("admin.users.getWithDetails", () => {
  const channel = (userId: string, over: Partial<typeof youtubeChannels.$inferInsert> = {}) => ({
    userId,
    channelId: `UC-${randomUUID()}`,
    channelName: "My Channel",
    accessToken: "enc-a",
    refreshToken: "enc-r",
    tokenExpiry: new Date(Date.now() + 3_600_000),
    ...over,
  });

  test("costs three statements however many videos there are, and returns exactly what the five-statement version returned", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const withChannel = await makeUser();
      await upsertSettings(tx, withChannel.id, { autoPublishEnabled: true, telegramChatId: "42", deepseekApiKey: "enc" });
      await tx.insert(youtubeChannels).values([channel(withChannel.id, { isPrimary: true, oauthStatus: "token_expired" }), channel(withChannel.id, { channelName: "Second" })]);
      const t0 = Date.now() - 10_000_000;
      const made = await tx
        .insert(videos)
        .values(Array.from({ length: 205 }, (_, i) => ({ userId: withChannel.id, title: `v${i}`, rawFileKey: `k${i}`, rawFileSize: i + 1, status: "ready" as const, createdAt: new Date(t0 + i * 1000) })))
        .returning({ id: videos.id });
      await tx.insert(jobs).values(Array.from({ length: 25 }, (_, i) => ({ userId: withChannel.id, videoId: made[0].id, type: "publish" as const, status: "failed" as const, error: `e${i}`, createdAt: new Date(t0 + i * 1000) })));

      const few = await makeUser();
      await tx.insert(videos).values({ userId: few.id, title: "only", rawFileKey: "k", rawFileSize: 3, status: "draft" });

      const big = await countQueries(() => callRpc("admin.users.getWithDetails", { userId: withChannel.id }, { user: admin, tx }));
      const small = await countQueries(() => callRpc("admin.users.getWithDetails", { userId: few.id }, { user: admin, tx }));
      expectCount("users.getWithDetails statements (205 videos)", big.queries, 3);
      expectCount("users.getWithDetails statements (1 video)", small.queries, 3);

      const d = big.result as { user: Record<string, unknown>; videos: unknown[]; videoCount: number; recentJobs: unknown[] };
      expect(d.videos).toHaveLength(200);
      expect(d.videoCount).toBe(205);
      expect(d.recentJobs).toHaveLength(20);
      expect(d.videos[0]).not.toHaveProperty("total"); // the window count never leaks into a video row
      expect(d.user).toMatchObject({ youtubeConnected: true, youtubeOAuthStatus: "token_expired", youtubeChannelName: "My Channel", autoPublishEnabled: true, hasTelegram: true, hasDeepseekApiKey: true });
      expect(big.result).toEqual(toWire(await legacyDetails(tx, withChannel.id)) as never);
      expect(small.result).toEqual(toWire(await legacyDetails(tx, few.id)) as never);
      expect((small.result as { videoCount: number }).videoCount).toBe(1);
    });
  });

  test("a user with no channel, only a secondary channel, no settings, or no videos is reported exactly as before; an unknown id is null", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const admin = asAdmin(user);
      const bare = await makeUser();
      const secondaryOnly = await makeUser();
      await tx.insert(youtubeChannels).values(channel(secondaryOnly.id)); // not primary
      for (const u of [bare, secondaryOnly]) {
        const got = (await callRpc("admin.users.getWithDetails", { userId: u.id }, { user: admin, tx })) as { user: Record<string, unknown>; videos: unknown[]; videoCount?: number; recentJobs: unknown[] };
        expect(got).toEqual(toWire(await legacyDetails(tx, u.id)) as never);
        expect(got.user.youtubeConnected).toBe(false);
        for (const k of ["youtubeChannelId", "youtubeChannelName", "youtubeOAuthStatus"]) expect(got.user).not.toHaveProperty(k);
        expect(got.videos).toEqual([]);
        expect(got.videoCount).toBe(0);
        expect(got.recentJobs).toEqual([]);
      }
    });
  });

  test("unknown id", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      expect(await callRpc("admin.users.getWithDetails", { userId: randomUUID() }, { user: asAdmin(user), tx })).toBeNull();
    });
  });
});

// ─── health.getStorageHealth ─────────────────────────────────────────────────

describe("admin.health.getStorageHealth", () => {
  test("returns exactly what the two-statement version returned, capped at 200 missing videos", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = asAdmin(user);
      const t0 = Date.now() - 50_000_000;
      await tx.insert(videos).values([
        ...Array.from({ length: 205 }, (_, i) => ({ userId: user.id, title: `m${i}`, rawFileKey: `k${i}`, rawFileSize: 1, status: "ready" as const, storageMissing: true, storageCheckedAt: new Date(t0 + i * 1000) })),
        { userId: user.id, title: "ok", rawFileKey: "k", rawFileSize: 1, status: "scheduled" as const, storageMissing: false, storageCheckedAt: new Date() },
        { userId: user.id, title: "unchecked", rawFileKey: "k", rawFileSize: 1, status: "ready" as const },
        { userId: user.id, title: "not relevant", rawFileKey: "k", rawFileSize: 1, status: "draft" as const, storageMissing: true, storageCheckedAt: new Date() },
      ]);

      const run = await countQueries(() => callRpc("admin.health.getStorageHealth", {}, { user: admin, tx }));
      expectCount("health.getStorageHealth statements", run.queries, 1);

      type Health = { totalRelevant: number; missingCount: number; healthyCount: number; uncheckedCount: number; missingVideos: { videoId: string; title: string; userEmail: string; status: string; checkedAt?: number }[] };
      const canon = (h: Health) => ({ ...h, missingVideos: [...h.missingVideos].sort((a, b) => (b.checkedAt ?? -1) - (a.checkedAt ?? -1) || a.videoId.localeCompare(b.videoId)) });
      const { got, want } = await settle(
        async () => ({ got: (await callRpc("admin.health.getStorageHealth", {}, { user: admin, tx })) as Health, want: toWire(await legacyStorageHealth(tx)) as Health }),
        (r) => JSON.stringify(canon(r.got)) === JSON.stringify(canon(r.want)),
      );
      expect(canon(got)).toEqual(canon(want));
      expect(got.missingVideos).toHaveLength(200);
      expect(got.missingCount).toBeGreaterThanOrEqual(205);
      expect(got.healthyCount).toBeGreaterThanOrEqual(1);
      expect(got.uncheckedCount).toBeGreaterThanOrEqual(1);
      const times = got.missingVideos.map((v) => v.checkedAt ?? -1);
      expect(times).toEqual([...times].sort((a, b) => b - a)); // newest check first
      expect(got.missingVideos.every((v) => v.userEmail === user.email)).toBe(true);
    });
  });

  test("healthy and unchecked videos alone still produce the totals (equal to the old answer)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = asAdmin(user);
      await tx.insert(videos).values([
        { userId: user.id, title: "ok", rawFileKey: "k", rawFileSize: 1, status: "ready", storageMissing: false, storageCheckedAt: new Date() },
        { userId: user.id, title: "new", rawFileKey: "k", rawFileSize: 1, status: "scheduled" },
      ]);
      const { got, want } = await settle(
        async () => ({ got: await callRpc("admin.health.getStorageHealth", {}, { user: admin, tx }), want: toWire(await legacyStorageHealth(tx)) }),
        (r) => JSON.stringify(r.got) === JSON.stringify(r.want),
      );
      expect(got).toEqual(want as never);
      expect((got as { totalRelevant: number }).totalRelevant).toBeGreaterThanOrEqual(2);
    });
  });
});
