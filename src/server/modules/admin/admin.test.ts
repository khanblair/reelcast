/**
 * Admin module tests.
 *  - Registry-wide: EVERY function under api.admin is admin-only (the Convex version had no auth).
 *  - Behaviour against the real DB inside a rolled-back transaction: plan/plan_source, last-admin
 *    guard, SQL aggregates, DTO secrecy, broadcast, delete.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/client";
import {
  contactSubmissions,
  jobs,
  notifications,
  settings,
  usageLedger,
  users,
  videos,
  youtubeChannels,
  youtubeQuotaUsage,
} from "@/db/schema";
import { monthKey } from "@/server/lib/usage";
import { callRpc, inRolledBackTx } from "@/server/testing";
import type { UserRow } from "../../rpc/define";
import { api } from "../../rpc/registry";

setDefaultTimeout(120_000);

// ─── helpers ─────────────────────────────────────────────────────────────────

const fakeUser = (over: Partial<UserRow> = {}): UserRow => ({
  id: randomUUID(),
  email: `fake-${randomUUID()}@example.com`,
  name: null,
  imageUrl: null,
  isAdmin: false,
  plan: "free",
  planSource: "default",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

type Def = { __rpc: true; kind: string; auth: string; input: z.ZodTypeAny };
const isDef = (v: unknown): v is Def => typeof v === "object" && v !== null && (v as { __rpc?: unknown }).__rpc === true;

/** Smallest valid value for a zod schema (enough for input validation to pass). */
function sample(schema: z.ZodTypeAny): unknown {
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case "ZodString": {
      const checks = (def.checks as { kind: string; value?: number }[]) ?? [];
      if (checks.some((c) => c.kind === "uuid")) return randomUUID();
      if (checks.some((c) => c.kind === "email")) return "a@example.com";
      if (checks.some((c) => c.kind === "url")) return "https://example.com";
      const min = Math.max(1, ...checks.filter((c) => c.kind === "min").map((c) => c.value ?? 1));
      return "x".repeat(min);
    }
    case "ZodNumber": {
      const checks = (def.checks as { kind: string; value?: number }[]) ?? [];
      return Math.max(1, ...checks.filter((c) => c.kind === "min").map((c) => c.value ?? 1));
    }
    case "ZodBoolean":
      return true;
    case "ZodEnum":
      return (def.values as string[])[0];
    case "ZodLiteral":
      return def.value;
    case "ZodArray":
      return [];
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return sample(def.innerType as z.ZodTypeAny);
    case "ZodEffects":
      return sample(def.schema as z.ZodTypeAny);
    case "ZodUnion":
      return sample((def.options as z.ZodTypeAny[])[0]);
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shape)) {
        if (v.isOptional()) continue;
        out[k] = sample(v);
      }
      return out;
    }
    default:
      throw new Error(`sample(): unsupported zod type ${def.typeName}`);
  }
}

/** Flat list of every admin rpc: [path, def]. */
function adminFns(): [string, Def][] {
  const out: [string, Def][] = [];
  for (const [modName, mod] of Object.entries(api.admin)) {
    for (const [fnName, fn] of Object.entries(mod as Record<string, unknown>)) {
      if (isDef(fn)) out.push([`admin.${modName}.${fnName}`, fn]);
    }
  }
  return out;
}

/** Make `n` extra users inside the (rolled back) transaction. Returns [] if FK bypass is not permitted. */
async function extraUsers(tx: DbLike, n: number, over: Partial<typeof users.$inferInsert> = {}): Promise<UserRow[]> {
  try {
    await tx.execute(sql`set local session_replication_role = replica`);
    const rows = await tx
      .insert(users)
      .values(Array.from({ length: n }, () => ({ id: randomUUID(), email: `t-${randomUUID()}@example.com`, ...over })))
      .returning();
    return rows;
  } catch {
    return [];
  }
}

/** Other agents' committed test rows may exist for the shared test user: start from a clean slate (rolled back). */
async function clearChannels(tx: DbLike, userId: string) {
  await tx.delete(youtubeChannels).where(sql`user_id = ${userId}`);
}

/** settings has a unique row per user and other tests may have committed one: upsert. */
async function upsertSettings(tx: DbLike, userId: string, values: Partial<typeof settings.$inferInsert>) {
  await tx.insert(settings).values({ userId, ...values }).onConflictDoUpdate({ target: settings.userId, set: values });
}

/** Every key anywhere in a JSON-able value. */
function allKeys(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      acc.push(k);
      allKeys(x, acc);
    }
  }
  return acc;
}

const FORBIDDEN_KEY = /(access|refresh)_?token|api_?key|secret|webhook_?url|password/i;
const SECRETS = ["SECRET-ACCESS-TOKEN-123", "SECRET-REFRESH-TOKEN-456", "SECRET-RESEND-KEY-789", "SECRET-DEEPSEEK-KEY-012", "https://discord.com/api/webhooks/SECRETHOOK"];

/** Key names are fine when they are `has*` booleans; anything else secret-looking is a leak. */
function assertNoSecrets(label: string, data: unknown) {
  const json = JSON.stringify(data);
  for (const s of SECRETS) expect(`${label}: ${json.includes(s)}`).toBe(`${label}: false`);
  const bad = allKeys(data).filter((k) => FORBIDDEN_KEY.test(k) && !/^has[A-Z]/.test(k));
  expect(`${label}: ${bad.join(",")}`).toBe(`${label}: `);
}

// ─── registry-wide authorisation ─────────────────────────────────────────────

describe("api.admin registry: every function is admin-only", () => {
  const fns = adminFns();

  test("the admin namespace is not empty and covers the ported modules", () => {
    const paths = fns.map(([p]) => p);
    for (const p of [
      "admin.users.setPlan", "admin.users.setAdmin", "admin.users.listAll", "admin.users.getWithDetails",
      "admin.videos.adminDelete", "admin.videos.listAll", "admin.notifications.broadcastToAll",
      "admin.stats.getStats", "admin.health.getTokenHealth", "admin.jobs.listFailed",
      "admin.contact.listAll", "admin.quota.getQuotaOverview", "admin.storage.getPerUserBreakdown",
      "admin.usageLedger.getOverview",
    ]) expect(paths).toContain(p);
  });

  test("every function is declared auth: 'admin'", () => {
    for (const [path, fn] of fns) expect(`${path}:${fn.auth}`).toBe(`${path}:admin`);
  });

  test("signed-out callers get UNAUTHENTICATED, non-admin users get FORBIDDEN", async () => {
    for (const [path, fn] of fns) {
      const args = sample(fn.input);
      await expect(callRpc(path, args, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(callRpc(path, args, { user: fakeUser({ isAdmin: false }) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  test("a user object that is not an admin is rejected even for the cheapest read", async () => {
    await expect(callRpc("admin.stats.getStats", {}, { user: fakeUser() })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── users: plan / admin guards ──────────────────────────────────────────────

describe("admin.users", () => {
  test("setPlan sets users.plan and plan_source ('admin' for paid grants, 'default' for free)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      const read = async () => (await tx.select({ plan: users.plan, source: users.planSource }).from(users).where(sql`id = ${user.id}`))[0];

      await callRpc("admin.users.setPlan", { userId: user.id, plan: "pro" }, { user: admin, tx });
      expect(await read()).toEqual({ plan: "pro", source: "admin" });
      await callRpc("admin.users.setPlan", { userId: user.id, plan: "elite" }, { user: admin, tx });
      expect(await read()).toEqual({ plan: "elite", source: "admin" });
      await callRpc("admin.users.setPlan", { userId: user.id, plan: "free" }, { user: admin, tx });
      expect(await read()).toEqual({ plan: "free", source: "default" });

      await expect(callRpc("admin.users.setPlan", { userId: randomUUID(), plan: "pro" }, { user: admin, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("admin.users.setPlan", { userId: user.id, plan: "platinum" }, { user: admin, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  test("setAdmin refuses self-demotion and removing the last admin", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.update(users).set({ isAdmin: false }).where(sql`id <> ${user.id}`); // rolled back
      await tx.update(users).set({ isAdmin: true }).where(sql`id = ${user.id}`);
      const isAdmin = async () => (await tx.select({ a: users.isAdmin }).from(users).where(sql`id = ${user.id}`))[0].a;

      // self-demotion
      await expect(callRpc("admin.users.setAdmin", { userId: user.id, isAdmin: false }, { user: { ...user, isAdmin: true }, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await isAdmin()).toBe(true);

      // a different admin tries to demote the only admin in the database
      const other = fakeUser({ isAdmin: true });
      await expect(callRpc("admin.users.setAdmin", { userId: user.id, isAdmin: false }, { user: other, tx })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await isAdmin()).toBe(true);

      await expect(callRpc("admin.users.setAdmin", { userId: randomUUID(), isAdmin: true }, { user: other, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  test("setAdmin can demote an admin when another admin remains, and can promote", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const [second] = await extraUsers(tx, 1);
      if (!second) return; // FK bypass unavailable in this environment
      await tx.update(users).set({ isAdmin: false }).where(sql`id not in (${user.id}, ${second.id})`);
      await tx.update(users).set({ isAdmin: true }).where(sql`id in (${user.id}, ${second.id})`);
      const admin = { ...user, isAdmin: true };

      await callRpc("admin.users.setAdmin", { userId: second.id, isAdmin: false }, { user: admin, tx });
      expect((await tx.select({ a: users.isAdmin }).from(users).where(sql`id = ${second.id}`))[0].a).toBe(false);

      await callRpc("admin.users.setAdmin", { userId: second.id, isAdmin: true }, { user: admin, tx });
      expect((await tx.select({ a: users.isAdmin }).from(users).where(sql`id = ${second.id}`))[0].a).toBe(true);

      // now two admins again: demoting the OTHER one is allowed, leaving exactly one
      await callRpc("admin.users.setAdmin", { userId: second.id, isAdmin: false }, { user: admin, tx });
      // and the last one is protected
      await expect(callRpc("admin.users.setAdmin", { userId: user.id, isAdmin: false }, { user: { ...second, isAdmin: true }, tx })).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  test("listAll / getWithDetails return DTOs: has-key booleans, never tokens, keys or webhook URLs", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      await upsertSettings(tx, user.id, {
        resendApiKey: SECRETS[2],
        deepseekApiKey: SECRETS[3],
        discordWebhookUrl: SECRETS[4],
        telegramChatId: "123456",
        autoPublishEnabled: true,
      });
      await clearChannels(tx, user.id);
      await tx.insert(youtubeChannels).values({
        userId: user.id,
        channelId: `UC-${randomUUID()}`,
        channelName: "Chan",
        accessToken: SECRETS[0],
        refreshToken: SECRETS[1],
        tokenExpiry: new Date(Date.now() + 3600_000),
        isPrimary: true,
      });

      const list = (await callRpc("admin.users.listAll", {}, { user: admin, tx })) as Record<string, unknown>[];
      const mine = list.find((u) => u._id === user.id)!;
      expect(mine).toBeTruthy();
      expect(mine.hasResendApiKey).toBe(true);
      expect(mine.hasDiscordWebhook).toBe(true);
      expect(mine.hasTelegram).toBe(true);
      expect(mine.autoPublishEnabled).toBe(true);
      expect(mine.youtubeConnected).toBe(true);
      assertNoSecrets("users.listAll", list);

      const detail = (await callRpc("admin.users.getWithDetails", { userId: user.id }, { user: admin, tx })) as { user: Record<string, unknown> };
      expect(detail.user.hasDeepseekApiKey).toBe(true);
      expect(detail.user.hasResendApiKey).toBe(true);
      assertNoSecrets("users.getWithDetails", detail);

      assertNoSecrets("health.getTokenHealth", await callRpc("admin.health.getTokenHealth", {}, { user: admin, tx }));

      expect(await callRpc("admin.users.getWithDetails", { userId: randomUUID() }, { user: admin, tx })).toBeNull();
    });
  });

  test("listAll searches and filters by plan in SQL, with a row cap", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      const needle = `zzneedle${Date.now()}`;
      const made = await extraUsers(tx, 2, { plan: "pro", planSource: "admin" });
      await tx.update(users).set({ name: `The ${needle} User`, plan: "pro" }).where(sql`id = ${user.id}`);
      const found = (await callRpc("admin.users.listAll", { search: needle }, { user: admin, tx })) as { _id: string }[];
      expect(found.map((u) => u._id)).toEqual([user.id]);
      const pros = (await callRpc("admin.users.listAll", { plan: "pro" }, { user: admin, tx })) as { _id: string; plan: string }[];
      expect(pros.every((u) => u.plan === "pro")).toBe(true);
      expect(pros.length).toBe(1 + made.length);
      const capped = (await callRpc("admin.users.listAll", { limit: 1 }, { user: admin, tx })) as unknown[];
      expect(capped.length).toBe(1);
      // LIKE wildcards in the search string are escaped, not interpreted
      expect(await callRpc("admin.users.listAll", { search: "%" }, { user: admin, tx })).toEqual([]);
    });
  });
});

// ─── SQL aggregates ──────────────────────────────────────────────────────────

describe("admin aggregates (SQL) match inserted rows", () => {
  test("stats.getStats, storage breakdown, health, jobs, quota, usage", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      const call = <T>(path: string, args: unknown = {}) => callRpc(path, args, { user: admin, tx }) as Promise<T>;

      type Stats = { totalUsers: number; totalVideos: number; publishedVideos: number; totalStorageBytes: number; jobsToday: number; successRate24h?: number; autoPublishActive: number; youtubeConnected: number; adminCount: number };
      type Breakdown = { userId: string; totalBytes: number; videoCount: number }[];

      await upsertSettings(tx, user.id, { autoPublishEnabled: true });
      const [v1, v2, v3] = await tx
        .insert(videos)
        .values([
          { userId: user.id, title: "pub 1", rawFileKey: "k1", rawFileSize: 100, status: "published", publishedVideoId: "yt1" },
          { userId: user.id, title: "pub 2", rawFileKey: "k2", rawFileSize: 200, status: "published", publishedVideoId: "yt2" },
          { userId: user.id, title: "ready 3", rawFileKey: "k3", rawFileSize: 300, status: "ready", storageMissing: true, storageCheckedAt: new Date() },
        ])
        .returning();
      const now = new Date();
      await tx.insert(jobs).values([
        { userId: user.id, videoId: v1.id, type: "publish", status: "completed", startedAt: now, completedAt: now },
        { userId: user.id, videoId: v2.id, type: "publish", status: "failed", error: "boom", startedAt: now, completedAt: now },
        { userId: user.id, videoId: v3.id, type: "generation", status: "pending" },
      ]);

      // The database is shared with other concurrently running test suites that commit rows, so
      // compare the RPC with plain SQL aggregates taken back-to-back (retrying if a foreign commit
      // landed in between), and check our own rows are at least counted.
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const direct = async () => {
        const [r] = (await tx.execute(sql`
          select (select count(*) from users)::int as "totalUsers",
                 (select count(*) from users where is_admin)::int as "adminCount",
                 (select count(*) from youtube_channels where is_primary)::int as "youtubeConnected",
                 (select count(*) from videos)::int as "totalVideos",
                 (select count(*) from videos where status = 'published')::int as "publishedVideos",
                 (select coalesce(sum(raw_file_size), 0) from videos)::float8 as "totalStorageBytes",
                 (select count(*) from jobs where started_at >= ${startOfDay.toISOString()}::timestamptz)::int as "jobsToday",
                 (select count(*) from settings where auto_publish_enabled)::int as "autoPublishActive",
                 (select count(*) from jobs where type = 'publish' and completed_at >= now() - interval '24 hours')::int as "finished",
                 (select count(*) from jobs where type = 'publish' and status = 'completed' and completed_at >= now() - interval '24 hours')::int as "ok"
        `)) as unknown as (Stats & { finished: number; ok: number })[];
        return r;
      };
      let got!: Stats;
      let want!: Stats & { finished: number; ok: number };
      for (let attempt = 0; attempt < 4; attempt++) {
        got = await call<Stats>("admin.stats.getStats");
        want = await direct();
        const same = (["totalUsers", "adminCount", "youtubeConnected", "totalVideos", "publishedVideos", "totalStorageBytes", "jobsToday", "autoPublishActive"] as const).every((k) => got[k] === want[k]);
        if (same) break;
      }
      for (const k of ["totalUsers", "adminCount", "youtubeConnected", "totalVideos", "publishedVideos", "totalStorageBytes", "jobsToday", "autoPublishActive"] as const) {
        expect(`${k}=${got[k]}`).toBe(`${k}=${want[k]}`);
      }
      expect(got.successRate24h).toBeCloseTo(want.ok / want.finished, 10);
      // our rows are in there
      expect(got.totalVideos).toBeGreaterThanOrEqual(3);
      expect(got.publishedVideos).toBeGreaterThanOrEqual(2);
      expect(got.totalStorageBytes).toBeGreaterThanOrEqual(600);
      expect(got.jobsToday).toBeGreaterThanOrEqual(2);
      expect(got.autoPublishActive).toBeGreaterThanOrEqual(1);

      // storage breakdown for this user == SQL sum over this user's videos
      let mine: Breakdown[number] | undefined;
      let sums = { bytes: 0, n: 0 };
      let storage: Breakdown = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        storage = await call<Breakdown>("admin.storage.getPerUserBreakdown");
        mine = storage.find((r) => r.userId === user.id);
        const [r] = (await tx.execute(sql`select coalesce(sum(raw_file_size), 0)::float8 as bytes, count(*)::int as n from videos where user_id = ${user.id}`)) as unknown as { bytes: number; n: number }[];
        sums = r;
        if (mine && mine.totalBytes === sums.bytes && mine.videoCount === sums.n) break;
      }
      expect(mine!.totalBytes).toBe(sums.bytes);
      expect(mine!.videoCount).toBe(sums.n);
      expect(mine!.totalBytes).toBeGreaterThanOrEqual(600);
      expect(storage.map((r) => r.totalBytes)).toEqual([...storage.map((r) => r.totalBytes)].sort((a, b) => b - a));

      // storage health: v3 is flagged missing
      const sh = await call<{ totalRelevant: number; missingCount: number; missingVideos: { videoId: string; userEmail: string }[] }>("admin.health.getStorageHealth");
      expect(sh.missingVideos.some((m) => m.videoId === v3.id && m.userEmail === user.email)).toBe(true);
      expect(sh.missingCount).toBeGreaterThanOrEqual(1);
      expect(sh.totalRelevant).toBeGreaterThanOrEqual(1);

      // jobs lists (joined with user + video)
      const failed = await call<{ _id: string; type: string; error?: string; userEmail: string; videoTitle: string }[]>("admin.jobs.listFailed", { limit: 200 });
      const f = failed.find((j) => j.error === "boom")!;
      expect(typeof f.type).toBe("string"); // the admin overview labels each row by type
      expect(f.userEmail).toBe(user.email);
      expect(f.videoTitle).toBe("pub 2");
      expect(failed.every((j) => (j as unknown as { status: string }).status === "failed")).toBe(true);
      const recent = await call<unknown[]>("admin.jobs.listRecent", { limit: 2 });
      expect(recent.length).toBe(2);

      // quota overview
      const today = new Date().toISOString().slice(0, 10);
      await tx
        .insert(youtubeQuotaUsage)
        .values({ userId: user.id, date: today, unitsUsed: 4242 })
        .onConflictDoUpdate({ target: [youtubeQuotaUsage.userId, youtubeQuotaUsage.date], set: { unitsUsed: 4242 } });
      const quota = await call<{ userId: string; email: string; unitsUsed: number }[]>("admin.quota.getQuotaOverview");
      expect(quota.find((q) => q.userId === user.id)).toMatchObject({ email: user.email, unitsUsed: 4242 });
      expect(await call<{ unitsUsed: number }>("admin.quota.getTodayQuotaUsage", { userId: user.id })).toMatchObject({ unitsUsed: 4242 });

      // usage overview: free plan caps are videos 10 / metadata 5; veo 0 and ai 0 are NOT "at limit"
      await tx.update(users).set({ plan: "free" }).where(sql`id = ${user.id}`);
      const ledger = { videosUploaded: 3, metadataGenerated: 1, veoGenerated: 0, aiMessagesUsed: 0 };
      await tx
        .insert(usageLedger)
        .values({ userId: user.id, month: monthKey(), ...ledger })
        .onConflictDoUpdate({ target: [usageLedger.userId, usageLedger.month], set: ledger });
      type Row = { userId: string; atLimit: boolean; videosUploaded: number; limits: { videosUploaded: number; veoGenerated: number } };
      let rows = await call<Row[]>("admin.usageLedger.getOverview");
      let mineUsage = rows.find((r) => r.userId === user.id)!;
      expect(mineUsage.videosUploaded).toBe(3);
      expect(mineUsage.limits).toMatchObject({ videosUploaded: 10, veoGenerated: 0 });
      expect(mineUsage.atLimit).toBe(false);

      await tx.update(usageLedger).set({ videosUploaded: 10 }).where(sql`user_id = ${user.id}`);
      rows = await call<Row[]>("admin.usageLedger.getOverview");
      mineUsage = rows.find((r) => r.userId === user.id)!;
      expect(mineUsage.atLimit).toBe(true);
      const limited = await call<Row[]>("admin.usageLedger.getOverview", { atLimit: true });
      expect(limited.every((r) => r.atLimit)).toBe(true);
      expect(limited.some((r) => r.userId === user.id)).toBe(true);
      const frees = await call<{ plan: string }[]>("admin.usageLedger.getOverview", { plan: "elite" });
      expect(frees.some((r) => (r as unknown as { userId: string }).userId === user.id)).toBe(false);

      const summary = await call<{ total: number; free: number; pro: number; elite: number; atLimit: number }>("admin.usageLedger.getSummary");
      expect(summary.free + summary.pro + summary.elite).toBe(summary.total);
      expect(summary.atLimit).toBeGreaterThanOrEqual(1);
    });
  });

  test("health.getTokenHealth counts by status", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      type TH = { total: number; counts: Record<string, number>; rows: { channelId: string; oauthStatus: string }[] };
      await clearChannels(tx, user.id);
      await tx.insert(youtubeChannels).values([
        { userId: user.id, channelId: `UC-${randomUUID()}`, accessToken: "a", tokenExpiry: new Date(), oauthStatus: "revoked", isPrimary: true },
        { userId: user.id, channelId: `UC-${randomUUID()}`, accessToken: "b", tokenExpiry: new Date(), oauthStatus: "token_expired" },
      ]);
      // shared DB: compare with plain SQL taken back-to-back (retry if a foreign commit landed between)
      let got!: TH;
      let want: Record<string, number> = {};
      for (let attempt = 0; attempt < 4; attempt++) {
        got = (await callRpc("admin.health.getTokenHealth", {}, { user: admin, tx })) as TH;
        const rows = (await tx.execute(sql`select coalesce(oauth_status, 'unknown') as s, count(*)::int as n from youtube_channels group by 1`)) as unknown as { s: string; n: number }[];
        want = Object.fromEntries(rows.map((r) => [r.s, r.n]));
        const total = rows.reduce((a, r) => a + r.n, 0);
        if (got.total === total && (["connected", "token_expired", "revoked", "unknown"] as const).every((k) => (got.counts[k] ?? 0) === (want[k] ?? 0))) break;
      }
      for (const k of ["connected", "token_expired", "revoked", "unknown"] as const) expect(`${k}=${got.counts[k] ?? 0}`).toBe(`${k}=${want[k] ?? 0}`);
      expect(got.counts.revoked).toBeGreaterThanOrEqual(1);
      expect(got.counts.token_expired).toBeGreaterThanOrEqual(1);
      expect(got.rows.filter((r) => r.oauthStatus === "revoked").length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─── contact, notifications, delete ──────────────────────────────────────────

describe("admin.contact", () => {
  test("list (status filtered in SQL), markRead, remove", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      const [a, b] = await tx
        .insert(contactSubmissions)
        .values([
          { name: "A", email: "a@example.com", subject: "s1", message: "m1" },
          { name: "B", email: "b@example.com", subject: "s2", message: "m2", status: "read" },
        ])
        .returning();
      type S = { _id: string; status: string };
      const news = (await callRpc("admin.contact.listAll", { status: "new" }, { user: admin, tx })) as S[];
      expect(news.some((s) => s._id === a.id)).toBe(true);
      expect(news.some((s) => s._id === b.id)).toBe(false);
      expect(news.every((s) => s.status === "new")).toBe(true);

      await callRpc("admin.contact.markRead", { submissionId: a.id }, { user: admin, tx });
      expect(((await callRpc("admin.contact.listAll", { status: "read" }, { user: admin, tx })) as S[]).some((s) => s._id === a.id)).toBe(true);

      await callRpc("admin.contact.remove", { submissionId: a.id }, { user: admin, tx });
      await expect(callRpc("admin.contact.remove", { submissionId: a.id }, { user: admin, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("admin.contact.markRead", { submissionId: randomUUID() }, { user: admin, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});

describe("admin.notifications", () => {
  test("broadcastToAll inserts one notification per user, in bounded batches", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      const extras = await extraUsers(tx, 3);
      const [{ n }] = (await tx.execute(sql`select count(*)::int as n from users`)) as unknown as { n: number }[];

      const res = (await callRpc("admin.notifications.broadcastToAll", { title: "Hello", message: "World", type: "info", link: "/billing" }, { user: admin, tx })) as { sent: number; count: number };
      expect(res.sent).toBe(n);
      expect(res.count).toBe(n);
      expect(n).toBeGreaterThanOrEqual(1 + extras.length);
      const rows = await tx.select().from(notifications).where(sql`title = 'Hello' and message = 'World'`);
      expect(rows.length).toBe(n);
      expect(new Set(rows.map((r) => r.userId)).size).toBe(n);
      expect(rows.every((r) => !r.isRead && r.link === "/billing" && r.type === "info")).toBe(true);
    });
  });

  test("rejects unsafe links and oversized content; sendToUser checks the target exists", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      const base = { title: "t", message: "m", type: "info" as const };
      for (const link of ["javascript:alert(1)", "//evil.example", "data:text/html,x"]) {
        await expect(callRpc("admin.notifications.broadcastToAll", { ...base, link }, { user: admin, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      await expect(callRpc("admin.notifications.broadcastToAll", { ...base, title: "x".repeat(201) }, { user: admin, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("admin.notifications.sendToUser", { ...base, userId: randomUUID() }, { user: admin, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await callRpc("admin.notifications.sendToUser", { ...base, userId: user.id, link: "https://example.com/x" }, { user: admin, tx });
      const rows = await tx.select().from(notifications).where(sql`user_id = ${user.id} and title = 't'`);
      expect(rows.length).toBe(1);
    });
  });
});

describe("admin.videos", () => {
  const realFetch = globalThis.fetch;
  const saved = { c: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, k: process.env.CLOUDINARY_API_KEY, s: process.env.CLOUDINARY_API_SECRET };
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = saved.c;
    process.env.CLOUDINARY_API_KEY = saved.k;
    process.env.CLOUDINARY_API_SECRET = saved.s;
    if (saved.c === undefined) delete process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    if (saved.k === undefined) delete process.env.CLOUDINARY_API_KEY;
    if (saved.s === undefined) delete process.env.CLOUDINARY_API_SECRET;
  });

  test("listAll filters by status and search in SQL and joins the owner", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      const tag = `qq${Date.now()}`;
      await tx.insert(videos).values([
        { userId: user.id, title: `${tag} alpha`, rawFileKey: "k", rawFileSize: 5, status: "draft" },
        { userId: user.id, title: `${tag} beta`, rawFileKey: "k", rawFileSize: 6, status: "failed" },
      ]);
      type V = { title: string; status: string; userEmail: string };
      const all = (await callRpc("admin.videos.listAll", { search: tag }, { user: admin, tx })) as V[];
      expect(all.length).toBe(2);
      expect(all.every((v) => v.userEmail === user.email)).toBe(true);
      const failed = (await callRpc("admin.videos.listAll", { search: tag, status: "failed" }, { user: admin, tx })) as V[];
      expect(failed.map((v) => v.title)).toEqual([`${tag} beta`]);
      expect(((await callRpc("admin.videos.listAll", { limit: 1 }, { user: admin, tx })) as unknown[]).length).toBe(1);
    });
  });

  test("adminDelete removes the row (children cascade) and destroys Cloudinary assets best-effort", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = "test-cloud";
      process.env.CLOUDINARY_API_KEY = "test-key";
      process.env.CLOUDINARY_API_SECRET = "test-secret";
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const [v] = await tx
        .insert(videos)
        .values({ userId: user.id, title: "to delete", rawFileKey: "https://res.cloudinary.com/test-cloud/video/upload/v1/folder/raw1.mp4", rawFileSize: 1, processedFileKey: "https://res.cloudinary.com/test-cloud/video/upload/v1/folder/proc1.mp4" })
        .returning();
      await tx.insert(jobs).values({ userId: user.id, videoId: v.id, type: "publish" });

      const res = (await callRpc("admin.videos.adminDelete", { videoId: v.id }, { user: admin, tx })) as { deleted: boolean; cloudinaryAttempted: number; cloudinaryFailed: number };
      expect(res).toMatchObject({ deleted: true, cloudinaryAttempted: 2, cloudinaryFailed: 0 });
      expect(calls.length).toBe(2);
      expect(calls.every((u) => u.startsWith("https://api.cloudinary.com/v1_1/test-cloud/video/destroy"))).toBe(true);
      expect((await tx.select().from(videos).where(sql`id = ${v.id}`)).length).toBe(0);
      expect((await tx.select().from(jobs).where(sql`video_id = ${v.id}`)).length).toBe(0);
      await expect(callRpc("admin.videos.adminDelete", { videoId: v.id }, { user: admin, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  test("a Cloudinary failure never blocks the delete", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = "test-cloud";
      process.env.CLOUDINARY_API_KEY = "test-key";
      process.env.CLOUDINARY_API_SECRET = "test-secret";
      globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
      const [v] = await tx
        .insert(videos)
        .values({ userId: user.id, title: "x", rawFileKey: "https://res.cloudinary.com/test-cloud/video/upload/v1/a.mp4", rawFileSize: 1 })
        .returning();
      const res = (await callRpc("admin.videos.adminDelete", { videoId: v.id }, { user: admin, tx })) as { cloudinaryFailed: number };
      expect(res.cloudinaryFailed).toBe(1);
      expect((await tx.select().from(videos).where(sql`id = ${v.id}`)).length).toBe(0);
    });
  });
});
