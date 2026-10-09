import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, type DbLike } from "@/db/client";
import { users, videoDailyStats, videos, youtubeChannels } from "@/db/schema";
import { decryptSecret, isEncrypted } from "../crypto";
import { saveYoutubeConnection } from "../lib/accounts/channels";
import { callRpc, inRolledBackTx } from "../testing";
import type { UserRow } from "../rpc/define";

setDefaultTimeout(60_000);

const cid = () => `UC_test_${randomUUID()}`;
const conn = (channelId: string, extra: Partial<Parameters<typeof saveYoutubeConnection>[2]> = {}) => ({
  channelId,
  channelName: `Channel ${channelId.slice(-4)}`,
  accessToken: "access-plain-1",
  refreshToken: "refresh-plain-1",
  expiresIn: 3600,
  ...extra,
});
const rows = (tx: DbLike, userId: string) => tx.select().from(youtubeChannels).where(eq(youtubeChannels.userId, userId));
const setPlan = (tx: DbLike, userId: string, plan: "free" | "pro" | "elite") => tx.update(users).set({ plan }).where(eq(users.id, userId));

/**
 * A second account for cross-account tests. The project has a single auth user and tests must
 * never create auth users, so this inserts a public.users row with FK triggers disabled
 * (`set local` => only for this transaction, which is always rolled back).
 */
async function secondUser(tx: DbLike): Promise<UserRow> {
  await tx.execute(sql`set local session_replication_role = replica`);
  const id = randomUUID();
  const [u] = await tx.insert(users).values({ id, email: `other-${id}@example.invalid` }).returning();
  return u;
}

describe("saveYoutubeConnection", () => {
  test("first channel becomes primary; tokens are stored encrypted", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const out = await saveYoutubeConnection(tx, user.id, conn("UC_one_" + randomUUID()));
      expect(out.isPrimary).toBe(true);
      const [row] = await rows(tx, user.id);
      expect(isEncrypted(row.accessToken)).toBe(true);
      expect(isEncrypted(row.refreshToken)).toBe(true);
      expect(row.accessToken).not.toContain("access-plain");
      expect(row.refreshToken).not.toContain("refresh-plain");
      expect(decryptSecret(row.accessToken)).toBe("access-plain-1");
      expect(decryptSecret(row.refreshToken as string)).toBe("refresh-plain-1");
      expect(row.oauthStatus).toBe("connected");
    });
  });

  test("free plan: one channel only (PLAN_LIMIT_EXCEEDED), but re-connecting that channel is fine", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const a = cid();
      await saveYoutubeConnection(tx, user.id, conn(a));
      const err = await saveYoutubeConnection(tx, user.id, conn(cid())).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "PLAN_LIMIT_EXCEEDED" });
      expect((err as Error).message).toContain("PLAN_LIMIT_EXCEEDED:youtubeChannels:free");
      expect((await rows(tx, user.id)).length).toBe(1);

      // re-connect: allowed, keeps the old refresh token when Google sends none, replaces it when it does
      const before = (await rows(tx, user.id))[0];
      await saveYoutubeConnection(tx, user.id, conn(a, { accessToken: "access-plain-2", refreshToken: undefined, channelName: "Renamed" }));
      let row = (await rows(tx, user.id))[0];
      expect(row.id).toBe(before.id);
      expect(row.refreshToken).toBe(before.refreshToken);
      expect(decryptSecret(row.accessToken)).toBe("access-plain-2");
      expect(row.channelName).toBe("Renamed");
      expect(row.isPrimary).toBe(true);

      await saveYoutubeConnection(tx, user.id, conn(a, { refreshToken: "refresh-plain-9" }));
      row = (await rows(tx, user.id))[0];
      expect(decryptSecret(row.refreshToken as string)).toBe("refresh-plain-9");
    });
  });

  test("paid plans can add more channels; only the first is primary", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      await saveYoutubeConnection(tx, user.id, conn(cid()));
      const second = await saveYoutubeConnection(tx, user.id, conn(cid()));
      expect(second.isPrimary).toBe(false);
      const all = await rows(tx, user.id);
      expect(all.length).toBe(2);
      expect(all.filter((r) => r.isPrimary).length).toBe(1);
    });
  });

  test("a channel linked to another account is a CONFLICT and ownership never changes", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const other = await secondUser(tx);
      const shared = cid();
      await saveYoutubeConnection(tx, other.id, conn(shared, { accessToken: "theirs" }));
      // Free user already at the 1-channel limit: still told the channel is taken, not "upgrade".
      await saveYoutubeConnection(tx, user.id, conn(cid()));

      const err = await saveYoutubeConnection(tx, user.id, conn(shared, { accessToken: "mine" })).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "CONFLICT" });
      expect((err as Error).message).toContain("already connected to another account");

      const [row] = await tx.select().from(youtubeChannels).where(eq(youtubeChannels.channelId, shared));
      expect(row.userId).toBe(other.id);
      expect(decryptSecret(row.accessToken)).toBe("theirs");
      expect((await rows(tx, user.id)).length).toBe(1);
    });
  });
});

describe("youtubeChannels rpc", () => {
  test("list never exposes tokens", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      expect(await callRpc("youtubeChannels.list", {}, { user: null })).toEqual([]);
      await saveYoutubeConnection(tx, user.id, conn(cid()));
      const list = (await callRpc("youtubeChannels.list", {}, { user, tx })) as Record<string, unknown>[];
      expect(list.length).toBe(1);
      expect(list[0]).toMatchObject({ isPrimary: true, oauthStatus: "connected" });
      expect(typeof list[0]._id).toBe("string");
      const json = JSON.stringify(list);
      expect(json).not.toContain("accessToken");
      expect(json).not.toContain("refreshToken");
      expect(json).not.toContain("v1:");
    });
  });

  test("setPrimary switches in one transaction: exactly one primary, the chosen one", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      const [a, b, c] = [cid(), cid(), cid()];
      for (const id of [a, b, c]) await saveYoutubeConnection(tx, user.id, conn(id));

      await callRpc("youtubeChannels.setPrimary", { channelId: c }, { user, tx });
      let all = await rows(tx, user.id);
      expect(all.filter((r) => r.isPrimary).map((r) => r.channelId)).toEqual([c]);

      await callRpc("youtubeChannels.setPrimary", { channelId: b }, { user, tx });
      all = await rows(tx, user.id);
      expect(all.filter((r) => r.isPrimary).map((r) => r.channelId)).toEqual([b]);

      // idempotent
      await callRpc("youtubeChannels.setPrimary", { channelId: b }, { user, tx });
      expect((await rows(tx, user.id)).filter((r) => r.isPrimary).length).toBe(1);
    });
  });

  test("setPrimary for an unknown channel is NOT_FOUND and leaves the current primary alone", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const a = cid();
      await saveYoutubeConnection(tx, user.id, conn(a));
      await expect(callRpc("youtubeChannels.setPrimary", { channelId: "UC_nope" }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const all = await rows(tx, user.id);
      expect(all.filter((r) => r.isPrimary).map((r) => r.channelId)).toEqual([a]);
    });
  });

  test("the database refuses two primaries for one user (partial unique index)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      await saveYoutubeConnection(tx, user.id, conn(cid()));
      const second = await saveYoutubeConnection(tx, user.id, conn(cid()));
      await expect(
        tx.transaction(async (sp) => {
          await sp.update(youtubeChannels).set({ isPrimary: true }).where(eq(youtubeChannels.id, second.id));
        }),
      ).rejects.toThrow();
      expect((await rows(tx, user.id)).filter((r) => r.isPrimary).length).toBe(1);
    });
  });

  test("remove: promotes the oldest remaining channel, purges analytics, only your own channels", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      const [a, b, c] = [cid(), cid(), cid()];
      const t0 = Date.now();
      await tx.insert(youtubeChannels).values(
        [a, b, c].map((channelId, i) => ({
          userId: user.id,
          channelId,
          accessToken: "x",
          tokenExpiry: new Date(t0 + 3_600_000),
          isPrimary: i === 0,
          createdAt: new Date(t0 - (10 - i) * 1000),
        })),
      );
      const [v] = await tx.insert(videos).values({ userId: user.id, title: "t", rawFileKey: "k", rawFileSize: 1 }).returning();
      await tx.insert(videoDailyStats).values({ videoId: v.id, userId: user.id, day: "2026-01-01" });

      await callRpc("youtubeChannels.remove", { channelId: a }, { user, tx });
      const all = await rows(tx, user.id);
      expect(all.map((r) => r.channelId).sort()).toEqual([b, c].sort());
      expect(all.filter((r) => r.isPrimary).map((r) => r.channelId)).toEqual([b]); // oldest remaining
      expect((await tx.select().from(videoDailyStats).where(eq(videoDailyStats.userId, user.id))).length).toBe(0);

      await expect(callRpc("youtubeChannels.remove", { channelId: a }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });

      // a different account cannot remove or promote your channels
      const stranger: UserRow = { ...user, id: randomUUID() };
      await expect(callRpc("youtubeChannels.remove", { channelId: b }, { user: stranger, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await rows(tx, user.id)).length).toBe(2);
    });
  });

  test("users.disconnectYoutube removes every channel and purges analytics", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      await saveYoutubeConnection(tx, user.id, conn(cid()));
      await saveYoutubeConnection(tx, user.id, conn(cid()));
      const [v] = await tx.insert(videos).values({ userId: user.id, title: "t", rawFileKey: "k", rawFileSize: 1 }).returning();
      await tx.insert(videoDailyStats).values({ videoId: v.id, userId: user.id, day: "2026-01-01" });

      expect(((await callRpc("users.current", {}, { user, tx })) as Record<string, unknown>).youtubeConnected).toBe(true);
      await callRpc("users.disconnectYoutube", {}, { user, tx });
      expect((await rows(tx, user.id)).length).toBe(0);
      expect((await tx.select().from(videoDailyStats).where(eq(videoDailyStats.userId, user.id))).length).toBe(0);
      expect(((await callRpc("users.current", {}, { user, tx })) as Record<string, unknown>).youtubeConnected).toBe(false);
    });
  });

  test("OAuth tokens cannot be written through rpc (no addOrUpdate / saveYoutubeTokens / migrateFromLegacy)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      for (const path of ["youtubeChannels.addOrUpdate", "youtubeChannels.migrateFromLegacy", "users.saveYoutubeTokens", "users.store", "users.updateOAuthStatus"]) {
        await expect(callRpc(path, {}, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    });
  });
});

// ─── true concurrency: committed rows from throwaway accounts, always cleaned up ───────────
describe("concurrent channel changes (committed rows, cleaned up)", () => {
  const created: string[] = [];

  async function throwawayUser(plan: "free" | "pro") {
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`); // no auth.users row: never create auth users
      await tx.insert(users).values({ id, email: `concurrent-${id}@example.invalid`, plan });
    });
    created.push(id);
    return id;
  }

  beforeAll(async () => {
    created.length = 0;
    // A killed earlier run can leave its throwaway accounts behind: sweep ones older than 10 minutes.
    await db.execute(sql`delete from users where email like 'concurrent-%@example.invalid' and created_at < now() - interval '10 minutes'`);
  });
  afterAll(async () => {
    if (created.length) await db.delete(users).where(inArray(users.id, created)); // cascades channels
  });

  test("free plan: two simultaneous different channels -> exactly one is stored", async () => {
    const uid = await throwawayUser("free");
    const results = await Promise.allSettled([saveYoutubeConnection(db, uid, conn(cid())), saveYoutubeConnection(db, uid, conn(cid()))]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "PLAN_LIMIT_EXCEEDED" });
    const all = await db.select().from(youtubeChannels).where(eq(youtubeChannels.userId, uid));
    expect(all.length).toBe(1);
    expect(all[0].isPrimary).toBe(true);
  });

  test("paid plan: simultaneous first channels -> one primary, no unique-index error", async () => {
    const uid = await throwawayUser("pro");
    const results = await Promise.allSettled([1, 2, 3].map(() => saveYoutubeConnection(db, uid, conn(cid()))));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const all = await db.select().from(youtubeChannels).where(eq(youtubeChannels.userId, uid));
    expect(all.length).toBe(3);
    expect(all.filter((r) => r.isPrimary).length).toBe(1);
  });

  test("simultaneous setPrimary calls never violate the unique index and end with one primary", async () => {
    const uid = await throwawayUser("pro");
    const ids = [cid(), cid(), cid(), cid()];
    for (const id of ids) await saveYoutubeConnection(db, uid, conn(id));
    const results = await Promise.allSettled([
      callRpc("youtubeChannels.setPrimary", { channelId: ids[1] }, { user: { id: uid } as UserRow }),
      callRpc("youtubeChannels.setPrimary", { channelId: ids[2] }, { user: { id: uid } as UserRow }),
      callRpc("youtubeChannels.setPrimary", { channelId: ids[3] }, { user: { id: uid } as UserRow }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const all = await db.select().from(youtubeChannels).where(eq(youtubeChannels.userId, uid));
    expect(all.filter((r) => r.isPrimary).length).toBe(1);
  });

  test("two accounts claiming the same channel at once: one wins, the other gets CONFLICT", async () => {
    const [u1, u2] = [await throwawayUser("pro"), await throwawayUser("pro")];
    const shared = cid();
    const results = await Promise.allSettled([saveYoutubeConnection(db, u1, conn(shared)), saveYoutubeConnection(db, u2, conn(shared))]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "CONFLICT" });
    expect((await db.select().from(youtubeChannels).where(eq(youtubeChannels.channelId, shared))).length).toBe(1);
  });
});
