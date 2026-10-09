import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { youtubeChannels } from "@/db/schema";
import { NonRetryableError } from "@/server/jobs/handlers";
import { inRolledBackTx } from "@/server/testing";
import { makeDeps, mkChannel } from "./dbkit";
import { checkAllChannels, checkChannelOAuthHealth, checkUserOAuthHealth } from "./oauth";
import { FakeWorld } from "./testkit";

setDefaultTimeout(120_000);

const statusOf = async (tx: Parameters<typeof mkChannel>[0], id: string) =>
  (await tx.select({ s: youtubeChannels.oauthStatus }).from(youtubeChannels).where(eq(youtubeChannels.id, id)))[0].s;

describe("checkChannelOAuthHealth", () => {
  test("a working token -> connected, 1 quota unit counted", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await mkChannel(tx, user.id, { oauthStatus: "unknown" });
      const { deps, spies } = makeDeps(new FakeWorld(1));
      expect(await checkChannelOAuthHealth(tx, ch.id, deps)).toBe("connected");
      expect(await statusOf(tx, ch.id)).toBe("connected");
      expect(spies.quota).toEqual([[user.id, 1]]);
      expect(spies.notifications).toEqual([]);
    });
  });

  test("401 on a token we thought valid -> force a refresh -> connected", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await mkChannel(tx, user.id);
      const world = new FakeWorld(1);
      world.channelsStatus = 401;
      let expiryAtRefresh: Date | null = null;
      const { deps, spies } = makeDeps(world, {
        getValidAccessToken: async (_db, id) => {
          spies.tokenCalls.push(id);
          if (spies.tokenCalls.length === 2) {
            expiryAtRefresh = (await tx.select({ e: youtubeChannels.tokenExpiry }).from(youtubeChannels).where(eq(youtubeChannels.id, id)))[0].e;
          }
          return { accessToken: "tok", channelId: "UC" };
        },
      });
      expect(await checkChannelOAuthHealth(tx, ch.id, deps)).toBe("connected");
      expect(spies.tokenCalls).toHaveLength(2);
      expect(expiryAtRefresh!.getTime()).toBeLessThan(Date.now()); // the refresh was forced
    });
  });

  test("401 and the refresh is rejected -> revoked, user told exactly once", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await mkChannel(tx, user.id, { channelName: "My Channel" });
      const world = new FakeWorld(1);
      world.channelsStatus = 401;
      let calls = 0;
      const { deps, spies } = makeDeps(world, {
        getValidAccessToken: async (_db, id) => {
          if (++calls === 1) return { accessToken: "tok", channelId: "UC" };
          await tx.update(youtubeChannels).set({ oauthStatus: "revoked" }).where(eq(youtubeChannels.id, id)); // what tokens.ts records
          throw new NonRetryableError("revoked");
        },
      });
      expect(await checkChannelOAuthHealth(tx, ch.id, deps)).toBe("revoked");
      expect(await statusOf(tx, ch.id)).toBe("revoked");
      expect(spies.notifications).toHaveLength(1);
      expect(spies.notifications[0]).toMatchObject({ type: "error", link: "/settings/youtube" });
      expect(spies.notifications[0].message).toContain("My Channel");

      // The 6-hourly sweep finds it still revoked: no second notification.
      calls = 0;
      expect(await checkChannelOAuthHealth(tx, ch.id, deps)).toBe("revoked");
      expect(spies.notifications).toHaveLength(1);
    });
  });

  test("token fetch fails with the status tokens.ts recorded -> that status (revoked notifies, token_expired does not)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const a = await mkChannel(tx, user.id);
      const b = await mkChannel(tx, user.id);
      const { deps, spies } = makeDeps(new FakeWorld(1), {
        getValidAccessToken: async (_db, id) => {
          await tx.update(youtubeChannels).set({ oauthStatus: id === a.id ? "revoked" : "token_expired" }).where(eq(youtubeChannels.id, id));
          throw new Error("refresh failed");
        },
      });
      expect(await checkChannelOAuthHealth(tx, a.id, deps)).toBe("revoked");
      expect(await checkChannelOAuthHealth(tx, b.id, deps)).toBe("token_expired");
      expect(spies.notifications).toHaveLength(1);
    });
  });

  test("a network failure or odd status is 'unknown', not revoked", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ch = await mkChannel(tx, user.id);
      const world = new FakeWorld(1);
      world.channelsStatus = 500;
      const { deps, spies } = makeDeps(world);
      const warn = console.warn;
      console.warn = () => {};
      try {
        expect(await checkChannelOAuthHealth(tx, ch.id, deps)).toBe("unknown");
        deps.fetch = async () => {
          throw new TypeError("fetch failed");
        };
        expect(await checkChannelOAuthHealth(tx, ch.id, deps)).toBe("unknown");
      } finally {
        console.warn = warn;
      }
      expect(await statusOf(tx, ch.id)).toBe("unknown");
      expect(spies.notifications).toEqual([]);
    });
  });

  test("an unknown channel id is 'unknown'", async () => {
    await inRolledBackTx(async ({ tx }) => {
      expect(await checkChannelOAuthHealth(tx, "00000000-0000-4000-8000-000000000000", makeDeps(new FakeWorld(1)).deps)).toBe("unknown");
    });
  });
});

describe("checkUserOAuthHealth / checkAllChannels", () => {
  test("no channels -> unknown; with channels -> the PRIMARY channel's status, all channels checked", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
      const { deps } = makeDeps(new FakeWorld(1));
      expect(await checkUserOAuthHealth(tx, user.id, deps)).toEqual({ userId: user.id, status: "unknown" });

      const primary = await mkChannel(tx, user.id, { isPrimary: true, oauthStatus: "unknown" });
      const second = await mkChannel(tx, user.id, { oauthStatus: "unknown" });
      expect(await checkUserOAuthHealth(tx, user.id, deps)).toEqual({ userId: user.id, status: "connected" });
      expect(await statusOf(tx, primary.id)).toBe("connected");
      expect(await statusOf(tx, second.id)).toBe("connected");
    });
  });

  test("checkAllChannels isolates failures, reports progress and honours its deadline", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const good = await mkChannel(tx, user.id, { oauthStatus: "unknown" });
      const bad = await mkChannel(tx, user.id, { oauthStatus: "unknown" });
      const { deps } = makeDeps(new FakeWorld(1), {
        getValidAccessToken: async (_db, id) => {
          if (id === bad.id) throw new TypeError("kaboom");
          return { accessToken: "tok", channelId: "UC" };
        },
      });
      const err = console.error;
      console.error = () => {};
      try {
        const channelIds = [good.id, bad.id];
        const out = await checkAllChannels(tx, { deadline: Date.now() + 60_000, deps, channelIds });
        expect(out.total).toBe(2);
        expect(out.checked).toBe(2); // a channel whose check "fails" is still handled (status unknown)
        expect(await statusOf(tx, good.id)).toBe("connected");
        expect(await statusOf(tx, bad.id)).toBe("unknown");

        const none = await checkAllChannels(tx, { deadline: Date.now() - 1, deps, channelIds });
        expect(none.checked).toBe(0);
      } finally {
        console.error = err;
      }
    });
  });
});
