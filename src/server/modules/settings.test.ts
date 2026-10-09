import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { settings, tasks } from "@/db/schema";
import { decryptSecret, isEncrypted } from "../crypto";
import { nextSlotMs } from "../lib/accounts/settings";
import { callRpc, inRolledBackTx } from "../testing";

setDefaultTimeout(60_000);

const rawSettings = async (tx: DbLike, userId: string) => (await tx.select().from(settings).where(eq(settings.userId, userId)))[0];
const HOUR = 3_600_000;

describe("settings.update", () => {
  test("BYOK keys are encrypted at rest and never returned", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await callRpc("settings.update", { resendApiKey: "re_super_secret_123", deepseekApiKey: "sk-deepseek-secret-456" }, { user, tx });

      const row = await rawSettings(tx, user.id);
      for (const stored of [row.resendApiKey, row.deepseekApiKey]) {
        expect(isEncrypted(stored)).toBe(true);
        expect(stored).not.toContain("secret");
      }
      expect(decryptSecret(row.resendApiKey as string)).toBe("re_super_secret_123");
      expect(decryptSecret(row.deepseekApiKey as string)).toBe("sk-deepseek-secret-456");

      const got = (await callRpc("settings.get", {}, { user, tx })) as Record<string, unknown>;
      expect(got.hasResendApiKey).toBe(true);
      expect(got.hasDeepseekApiKey).toBe(true);
      expect("resendApiKey" in got).toBe(false);
      expect("deepseekApiKey" in got).toBe(false);
      expect(JSON.stringify(got)).not.toContain("secret");
      expect(JSON.stringify(got)).not.toContain(row.resendApiKey as string);

      // "" clears
      await callRpc("settings.update", { resendApiKey: "" }, { user, tx });
      expect((await rawSettings(tx, user.id)).resendApiKey).toBeNull();
      expect(((await callRpc("settings.get", {}, { user, tx })) as Record<string, unknown>).hasResendApiKey).toBe(false);
    });
  });

  test("allow-list: protected or unknown columns are rejected and nothing is written", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      for (const bad of [
        { autoPublishEnabled: true },
        { autoPublishNextAt: 123 },
        { userId: "00000000-0000-0000-0000-000000000000" },
        { id: "00000000-0000-0000-0000-000000000000" },
        { isAdmin: true },
        { aiTone: "casual", plan: "elite" },
      ]) {
        await expect(callRpc("settings.update", bad, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(await rawSettings(tx, user.id)).toBeUndefined();
    });
  });

  test("undefined leaves a column alone; null or empty string clears it; integers are validated", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await callRpc("settings.update", { aiTone: "casual", aiGuidelines: "be nice", telegramChatId: "12345", veoDurationSeconds: 6 }, { user, tx });
      await callRpc("settings.update", { aiLanguage: "fr" }, { user, tx });
      let row = await rawSettings(tx, user.id);
      expect(row).toMatchObject({ aiTone: "casual", aiGuidelines: "be nice", telegramChatId: "12345", aiLanguage: "fr", veoDurationSeconds: 6 });

      await callRpc("settings.update", { aiGuidelines: "   ", telegramChatId: null }, { user, tx });
      row = await rawSettings(tx, user.id);
      expect(row.aiGuidelines).toBeNull();
      expect(row.telegramChatId).toBeNull();
      expect(row.aiTone).toBe("casual");

      await expect(callRpc("settings.update", { veoDurationSeconds: 5.5 }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("settings.update", { notificationsEnabled: null }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  test("first save creates the row with defaults; aiAutoGenerate defaults to true and sticks once chosen", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await callRpc("settings.update", { aiTone: "technical" }, { user, tx });
      let row = await rawSettings(tx, user.id);
      expect(row.notificationsEnabled).toBe(false);
      expect(row.aiAutoGenerate).toBe(true);

      await callRpc("settings.update", { aiAutoGenerate: false }, { user, tx });
      await callRpc("settings.update", { aiTone: "casual" }, { user, tx });
      row = await rawSettings(tx, user.id);
      expect(row.aiAutoGenerate).toBe(false);

      // a pre-existing row with no explicit choice is backfilled
      await tx.update(settings).set({ aiAutoGenerate: null }).where(eq(settings.userId, user.id));
      await callRpc("settings.update", { aiTone: "casual" }, { user, tx });
      expect((await rawSettings(tx, user.id)).aiAutoGenerate).toBe(true);
    });
  });

  test("Discord webhook: only https discord.com / discordapp.com webhook URLs", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const bad = [
        "http://discord.com/api/webhooks/1/abc",
        "https://evil.com/api/webhooks/1/abc",
        "https://discord.com.evil.com/api/webhooks/1/abc",
        "https://evil.com/discord.com/api/webhooks/1/abc",
        "https://discord.com@evil.com/api/webhooks/1/abc",
        "https://user:pw@discord.com/api/webhooks/1/abc",
        "https://discord.com:8443/api/webhooks/1/abc",
        "https://discord.com/other/path",
        "https://169.254.169.254/api/webhooks/1/abc",
        "not a url",
      ];
      for (const url of bad) {
        await expect(callRpc("settings.update", { discordWebhookUrl: url }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(await rawSettings(tx, user.id)).toBeUndefined();

      await callRpc("settings.update", { discordWebhookUrl: "https://discord.com/api/webhooks/123/abcDEF" }, { user, tx });
      expect((await rawSettings(tx, user.id)).discordWebhookUrl).toBe("https://discord.com/api/webhooks/123/abcDEF");
      await callRpc("settings.update", { discordWebhookUrl: "https://discordapp.com/api/webhooks/123/abcDEF" }, { user, tx });
      expect((await rawSettings(tx, user.id)).discordWebhookUrl).toContain("discordapp.com");
      await callRpc("settings.update", { discordWebhookUrl: "" }, { user, tx });
      expect((await rawSettings(tx, user.id)).discordWebhookUrl).toBeNull();
    });
  });

  test("From address must look like an email", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("settings.update", { emailFromAddress: "nope" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await callRpc("settings.update", { emailFromAddress: "Reelcast <noreply@example.com>" }, { user, tx });
      expect((await rawSettings(tx, user.id)).emailFromAddress).toBe("Reelcast <noreply@example.com>");
    });
  });
});

describe("disconnects", () => {
  test("disconnectTelegram keeps notifications on only while Discord is still connected", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await callRpc("settings.update", { telegramChatId: "42", discordWebhookUrl: "https://discord.com/api/webhooks/1/x", notificationsEnabled: true }, { user, tx });
      await callRpc("settings.disconnectTelegram", {}, { user, tx });
      let row = await rawSettings(tx, user.id);
      expect(row.telegramChatId).toBeNull();
      expect(row.notificationsEnabled).toBe(true);

      await callRpc("settings.update", { telegramChatId: "42" }, { user, tx });
      await callRpc("settings.disconnectDiscord", {}, { user, tx });
      row = await rawSettings(tx, user.id);
      expect(row.discordWebhookUrl).toBeNull();
      await callRpc("settings.disconnectTelegram", {}, { user, tx });
      expect((await rawSettings(tx, user.id)).notificationsEnabled).toBe(false);
    });
  });

  test("disconnects are no-ops without a settings row", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await callRpc("settings.disconnectTelegram", {}, { user, tx });
      await callRpc("settings.disconnectDiscord", {}, { user, tx });
      expect(await rawSettings(tx, user.id)).toBeUndefined();
    });
  });
});

describe("auto-publish", () => {
  const key = (userId: string) => `autoPublish:${userId}`;
  const pending = (tx: DbLike, userId: string) =>
    tx.select().from(tasks).where(and(eq(tasks.dedupeKey, key(userId)), eq(tasks.status, "pending")));
  const base = (at: number) => ({ scheduledAt: at, intervalMs: 6 * HOUR, count: 2, privacy: "public" as const, timeSlots: [20, 7, 7, 12], timezoneOffset: 3 });

  test("start stores the schedule and queues one autoPublish.run task at scheduledAt", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const at = Date.now() + 2 * HOUR;
      await callRpc("settings.startAutoPublish", base(at), { user, tx });

      const row = await rawSettings(tx, user.id);
      expect(row).toMatchObject({ autoPublishEnabled: true, autoPublishIntervalMs: 6 * HOUR, autoPublishCount: 2, autoPublishPrivacy: "public", autoPublishTimezoneOffset: 3 });
      expect(row.autoPublishNextAt?.getTime()).toBe(at);
      expect(row.autoPublishTimeSlots).toEqual([7, 12, 20]);

      const t = await pending(tx, user.id);
      expect(t.length).toBe(1);
      expect(t[0]).toMatchObject({ kind: "autoPublish.run", userId: user.id, payload: { userId: user.id } });
      expect(t[0].runAt.getTime()).toBe(at);
    });
  });

  test("starting again replaces the pending run; stop cancels it and clears next-at", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const first = Date.now() + 2 * HOUR;
      const second = Date.now() + 5 * HOUR;
      await callRpc("settings.startAutoPublish", base(first), { user, tx });
      await callRpc("settings.startAutoPublish", base(second), { user, tx });
      const live = await pending(tx, user.id);
      expect(live.length).toBe(1);
      expect(live[0].runAt.getTime()).toBe(second);
      const all = await tx.select().from(tasks).where(eq(tasks.dedupeKey, key(user.id)));
      expect(all.filter((t) => t.status === "cancelled").length).toBe(1);

      await callRpc("settings.stopAutoPublish", {}, { user, tx });
      expect((await pending(tx, user.id)).length).toBe(0);
      const row = await rawSettings(tx, user.id);
      expect(row.autoPublishEnabled).toBe(false);
      expect(row.autoPublishNextAt).toBeNull();
      expect(row.autoPublishCount).toBe(2); // the configuration is kept for the next start
    });
  });

  test("validation: minimum 1h interval, slot range, time zone range", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const at = Date.now() + HOUR;
      await expect(callRpc("settings.startAutoPublish", { ...base(at), intervalMs: HOUR - 1 }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("settings.startAutoPublish", { ...base(at), timeSlots: [24] }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("settings.startAutoPublish", { ...base(at), count: 0 }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("settings.startAutoPublish", { ...base(at), privacy: "everyone" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("settings.startAutoPublish", { ...base(at), timezoneOffset: 15 }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await rawSettings(tx, user.id)).toBeUndefined();
      expect((await pending(tx, user.id)).length).toBe(0);
    });
  });

  test("half-hour time zones (IST = 5.5) are stored exactly", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await callRpc("settings.startAutoPublish", { ...base(Date.now() + HOUR), timezoneOffset: 5.5 }, { user, tx });
      expect((await rawSettings(tx, user.id))?.autoPublishTimezoneOffset).toBe(5.5);
    });
  });

  test("stop without settings is a no-op", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await callRpc("settings.stopAutoPublish", {}, { user, tx });
      expect(await rawSettings(tx, user.id)).toBeUndefined();
    });
  });
});

describe("nextSlotMs", () => {
  test("picks the next local slot at least 60s ahead, wrapping to tomorrow", () => {
    const midnightUtc = Date.UTC(2026, 0, 1, 0, 0, 0);
    // UTC+3: local 07:00 == 04:00Z
    expect(nextSlotMs([7, 12, 20], midnightUtc, 3)).toBe(Date.UTC(2026, 0, 1, 4, 0, 0));
    // local 12:30 (09:30Z): next is 20:00 local == 17:00Z
    expect(nextSlotMs([7, 12, 20], Date.UTC(2026, 0, 1, 9, 30, 0), 3)).toBe(Date.UTC(2026, 0, 1, 17, 0, 0));
    // after the last slot: tomorrow's first
    expect(nextSlotMs([7, 12, 20], Date.UTC(2026, 0, 1, 18, 0, 0), 3)).toBe(Date.UTC(2026, 0, 2, 4, 0, 0));
    // a slot less than 60s away is skipped
    expect(nextSlotMs([7, 12], Date.UTC(2026, 0, 1, 3, 59, 30), 3)).toBe(Date.UTC(2026, 0, 1, 9, 0, 0));
  });
});
