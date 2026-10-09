/**
 * Token refresh against the real database inside a rolled-back transaction; Google is a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DbLike } from "@/db/client";
import { videoDailyStats, videos, youtubeChannels } from "@/db/schema";
import { decryptSecret, encryptSecret, isEncrypted } from "@/server/crypto";
import { NonRetryableError } from "@/server/jobs/handlers";
import { inRolledBackTx } from "@/server/testing";
import { getPrimaryChannelRow, getValidAccessToken } from "./tokens";

setDefaultTimeout(60_000);

const realFetch = globalThis.fetch;
const savedEnv = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
let calls: { url: string; body: URLSearchParams }[] = [];

function mockGoogle(handler: (call: number) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
    return handler(calls.length);
  }) as typeof fetch;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  mockGoogle(() => {
    throw new Error("unexpected fetch");
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedEnv.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = savedEnv.id;
  if (savedEnv.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = savedEnv.secret;
});

async function seedChannel(tx: DbLike, userId: string, opts: { expiresInMs: number; status?: "connected" | "revoked" | "token_expired"; refresh?: string | null } = { expiresInMs: 3_600_000 }) {
  const [row] = await tx
    .insert(youtubeChannels)
    .values({
      userId,
      channelId: `UC_test_${randomUUID()}`,
      channelName: "Test channel",
      accessToken: encryptSecret("old-access-token"),
      refreshToken: opts.refresh === null ? null : encryptSecret(opts.refresh ?? "the-refresh-token"),
      tokenExpiry: new Date(Date.now() + opts.expiresInMs),
      oauthStatus: opts.status ?? "connected",
      isPrimary: true,
    })
    .returning();
  return row;
}

const reload = async (tx: DbLike, id: string) => (await tx.select().from(youtubeChannels).where(eq(youtubeChannels.id, id)))[0];

describe("getValidAccessToken", () => {
  test("returns the stored token without calling Google while it is fresh", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: 30 * 60_000 });
      const out = await getValidAccessToken(tx, ch.id);
      expect(out).toEqual({ accessToken: "old-access-token", channelId: ch.channelId });
      expect(calls.length).toBe(0);
    });
  });

  test("near expiry: refreshes, persists the new token ENCRYPTED, marks connected", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: 60_000, status: "token_expired" });
      mockGoogle(() => json(200, { access_token: "fresh-access-token", expires_in: 3599 }));

      const out = await getValidAccessToken(tx, ch.id);
      expect(out.accessToken).toBe("fresh-access-token");

      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
      expect(calls[0].body.get("grant_type")).toBe("refresh_token");
      expect(calls[0].body.get("refresh_token")).toBe("the-refresh-token");

      const row = await reload(tx, ch.id);
      expect(isEncrypted(row.accessToken)).toBe(true);
      expect(row.accessToken).not.toContain("fresh-access-token");
      expect(decryptSecret(row.accessToken)).toBe("fresh-access-token");
      expect(row.refreshToken).toBe(ch.refreshToken); // untouched when Google sends no new one
      expect(row.oauthStatus).toBe("connected");
      expect(row.tokenExpiry.getTime()).toBeGreaterThan(Date.now() + 3_000_000);

      // second call uses the persisted token, no more Google traffic
      expect((await getValidAccessToken(tx, ch.id)).accessToken).toBe("fresh-access-token");
      expect(calls.length).toBe(1);
    });
  });

  test("a rotated refresh token from Google is stored encrypted", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: -1000 });
      mockGoogle(() => json(200, { access_token: "a2", expires_in: 3600, refresh_token: "rotated-refresh" }));
      await getValidAccessToken(tx, ch.id);
      const row = await reload(tx, ch.id);
      expect(row.refreshToken).not.toContain("rotated-refresh");
      expect(decryptSecret(row.refreshToken as string)).toBe("rotated-refresh");
    });
  });

  test("invalid_grant: marks revoked, purges analytics, throws NonRetryableError", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: -1000 });
      const [v] = await tx.insert(videos).values({ userId: user.id, title: "t", rawFileKey: "x", rawFileSize: 1 }).returning();
      await tx.insert(videoDailyStats).values({ videoId: v.id, userId: user.id, day: "2026-01-01" });
      mockGoogle(() => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));

      await expect(getValidAccessToken(tx, ch.id)).rejects.toBeInstanceOf(NonRetryableError);

      expect((await reload(tx, ch.id)).oauthStatus).toBe("revoked");
      expect((await tx.select().from(videoDailyStats).where(eq(videoDailyStats.userId, user.id))).length).toBe(0);

      // a revoked channel is not retried against Google
      await expect(getValidAccessToken(tx, ch.id)).rejects.toBeInstanceOf(NonRetryableError);
      expect(calls.length).toBe(1);
    });
  });

  test("other failures: marks token_expired and throws a retryable error", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: -1000 });
      mockGoogle(() => json(503, { error: "backend_error" }));
      const err = await getValidAccessToken(tx, ch.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NonRetryableError);
      expect((await reload(tx, ch.id)).oauthStatus).toBe("token_expired");

      // network failure too
      mockGoogle(() => {
        throw new Error("socket hang up");
      });
      const err2 = await getValidAccessToken(tx, ch.id).catch((e: unknown) => e);
      expect(err2).not.toBeInstanceOf(NonRetryableError);
      expect((await reload(tx, ch.id)).oauthStatus).toBe("token_expired");
    });
  });

  test("no refresh token on file: revoked + NonRetryableError", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: -1000, refresh: null });
      await expect(getValidAccessToken(tx, ch.id)).rejects.toBeInstanceOf(NonRetryableError);
      expect(calls.length).toBe(0);
      expect((await reload(tx, ch.id)).oauthStatus).toBe("revoked");
    });
  });

  test("unreadable credentials are a server problem: no status change, no purge, retryable", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: -1000 });
      await tx.update(youtubeChannels).set({ refreshToken: "v1:AAAA:BBBB:CCCC" }).where(eq(youtubeChannels.id, ch.id));
      const err = await getValidAccessToken(tx, ch.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NonRetryableError);
      expect(calls.length).toBe(0);
      expect((await reload(tx, ch.id)).oauthStatus).toBe("connected");
    });
  });

  test("unknown channel row -> NonRetryableError", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await expect(getValidAccessToken(tx, randomUUID())).rejects.toBeInstanceOf(NonRetryableError);
    });
  });

  test("two simultaneous refreshes both succeed and leave an encrypted token (last write wins)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: -1000 });
      let n = 0;
      mockGoogle(async () => {
        n++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { access_token: `token-${n}`, expires_in: 3600 });
      });
      const [a, b] = await Promise.all([getValidAccessToken(tx, ch.id), getValidAccessToken(tx, ch.id)]);
      expect(a.accessToken).toMatch(/^token-[12]$/);
      expect(b.accessToken).toMatch(/^token-[12]$/);
      const row = await reload(tx, ch.id);
      expect(isEncrypted(row.accessToken)).toBe(true);
      expect(decryptSecret(row.accessToken)).toMatch(/^token-[12]$/);
      expect(row.oauthStatus).toBe("connected");
    });
  });

  test("a re-connect that lands while Google is being called is not overwritten or revoked", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await seedChannel(tx, user.id, { expiresInMs: -1000 });
      const reconnectedAccess = encryptSecret("reconnected-access");
      const reconnectedRefresh = encryptSecret("reconnected-refresh");
      mockGoogle(async () => {
        // the OAuth callback stores brand-new tokens while our refresh is in flight
        await tx
          .update(youtubeChannels)
          .set({ accessToken: reconnectedAccess, refreshToken: reconnectedRefresh, tokenExpiry: new Date(Date.now() + 3_600_000), oauthStatus: "connected" })
          .where(eq(youtubeChannels.id, ch.id));
        return json(400, { error: "invalid_grant" });
      });
      await expect(getValidAccessToken(tx, ch.id)).rejects.toBeInstanceOf(NonRetryableError);
      const row = await reload(tx, ch.id);
      expect(row.oauthStatus).toBe("connected");
      expect(row.refreshToken).toBe(reconnectedRefresh);
      expect(row.accessToken).toBe(reconnectedAccess);
    });
  });
});

describe("getPrimaryChannelRow", () => {
  test("returns the primary channel row, or null", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      expect(await getPrimaryChannelRow(tx, user.id)).toBeNull();
      const ch = await seedChannel(tx, user.id);
      const row = await getPrimaryChannelRow(tx, user.id);
      expect(row?.id).toBe(ch.id);
      expect(row?.channelId).toBe(ch.channelId);
    });
  });
});
