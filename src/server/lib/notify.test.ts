import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { encryptSecret } from "@/server/crypto";
import { inRolledBackTx } from "@/server/testing";
import { mockFetch, putSettings, setEnv } from "./generation/testkit";
import { isValidDiscordWebhook, renderTemplate, sendUserNotification } from "./notify";

setDefaultTimeout(60_000);

const DISCORD = "https://discord.com/api/webhooks/123/abc";
let restoreEnv: () => void;
let net: ReturnType<typeof mockFetch>;

beforeEach(() => {
  restoreEnv = setEnv({ TELEGRAM_BOT_TOKEN: "tg-test-token" });
  net = mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
});
afterEach(() => {
  net.restore();
  restoreEnv();
});

const body = (c: { init?: RequestInit }) => JSON.parse(String(c.init?.body)) as Record<string, unknown>;

describe("isValidDiscordWebhook (SSRF guard)", () => {
  test("accepts only https discord.com / discordapp.com webhook paths", () => {
    expect(isValidDiscordWebhook(DISCORD)).toBe(true);
    expect(isValidDiscordWebhook("https://discordapp.com/api/webhooks/1/x")).toBe(true);
  });
  test("rejects other hosts, schemes, lookalikes, credentials and ports", () => {
    for (const bad of [
      "http://discord.com/api/webhooks/1/x",
      "https://evil.example.com/api/webhooks/1/x",
      "https://discord.com.evil.com/api/webhooks/1/x",
      "https://evil.com/discord.com/api/webhooks/1/x",
      "https://discord.com@evil.com/api/webhooks/1/x",
      "https://user:pw@discord.com/api/webhooks/1/x",
      "https://discord.com:8443/api/webhooks/1/x",
      "https://discord.com/other/path",
      "https://169.254.169.254/api/webhooks/1/x",
      "https://localhost/api/webhooks/1/x",
      "not a url",
      "",
    ]) {
      expect(isValidDiscordWebhook(bad)).toBe(false);
    }
  });
});

describe("renderTemplate", () => {
  test("fills {{title}} and {{url}}, tolerates spaces, leaves unknown placeholders", () => {
    expect(renderTemplate("Published: {{title}} | {{ url }} {{other}}", { title: "T", url: "U" })).toBe("Published: T | U {{other}}");
  });
});

describe("sendUserNotification", () => {
  test("master switch off: nothing is sent", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await putSettings(tx, user.id, { notificationsEnabled: false, notifyOnPublishSuccess: true, telegramChatId: "42", discordWebhookUrl: DISCORD });
      await sendUserNotification(tx, user.id, "publishSuccess", { title: "T", url: "https://youtu.be/x" });
      expect(net.calls).toHaveLength(0);
    });
  });

  test("per-event toggle gates delivery (unset counts as off)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await putSettings(tx, user.id, { notificationsEnabled: true, notifyOnPublishFailure: true, telegramChatId: "42" });
      await sendUserNotification(tx, user.id, "publishSuccess", { title: "T" }); // toggle unset
      await sendUserNotification(tx, user.id, "weeklyDigest", { videosPublished: 1 }); // toggle unset
      expect(net.calls).toHaveLength(0);
      await sendUserNotification(tx, user.id, "publishFailure", { title: "T", error: "boom" });
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0].url).toBe("https://api.telegram.org/bottg-test-token/sendMessage");
      expect(body(net.calls[0]).chat_id).toBe("42");
      expect(String(body(net.calls[0]).text)).toContain("boom");
    });
  });

  test("fans out to Telegram, Discord and email, each with its own template/content", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await putSettings(tx, user.id, {
        notificationsEnabled: true,
        notifyOnPublishSuccess: true,
        telegramChatId: "42",
        telegramMessageTemplate: "TG {{title}} -> {{url}}",
        discordWebhookUrl: DISCORD,
        resendApiKey: encryptSecret("re_test_secret_key_123456"),
        emailNotificationsEnabled: true,
        emailFromAddress: "me@example.com",
      });
      await sendUserNotification(tx, user.id, "publishSuccess", { title: "My <b>Video</b>", youtubeVideoId: "abc123" });
      const tg = net.calls.find((c) => c.url.includes("api.telegram.org"));
      const dc = net.calls.find((c) => c.url === DISCORD);
      const em = net.calls.find((c) => c.url === "https://api.resend.com/emails");
      expect(body(tg!).text).toBe("TG My <b>Video</b> -> https://youtu.be/abc123");
      expect(String(body(dc!).content)).toContain("is now live on YouTube"); // default text: no discord template set
      expect((em!.init!.headers as Record<string, string>).Authorization).toBe("Bearer re_test_secret_key_123456");
      const mail = body(em!);
      expect(mail.from).toBe("me@example.com");
      expect(mail.to).toEqual([user.email]);
      expect(String(mail.html)).toContain("My &lt;b&gt;Video&lt;/b&gt;"); // HTML escaped
      expect(String(mail.html)).not.toContain("<b>Video</b>");
    });
  });

  test("email needs both the toggle and a key", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await putSettings(tx, user.id, { notificationsEnabled: true, notifyOnPublishSuccess: true, emailNotificationsEnabled: true });
      await sendUserNotification(tx, user.id, "publishSuccess", { title: "T" });
      await putSettings(tx, user.id, { notificationsEnabled: true, notifyOnPublishSuccess: true, resendApiKey: encryptSecret("re_x_key_1234567890"), emailNotificationsEnabled: false });
      await sendUserNotification(tx, user.id, "publishSuccess", { title: "T" });
      expect(net.calls).toHaveLength(0);
    });
  });

  test("never fetches a non-Discord webhook host", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await putSettings(tx, user.id, { notificationsEnabled: true, notifyOnPublishSuccess: true, discordWebhookUrl: "https://evil.example.com/api/webhooks/1/x" });
      await sendUserNotification(tx, user.id, "publishSuccess", { title: "T" });
      await putSettings(tx, user.id, { notificationsEnabled: true, notifyOnPublishSuccess: true, discordWebhookUrl: "http://169.254.169.254/latest/meta-data" });
      await sendUserNotification(tx, user.id, "publishSuccess", { title: "T" });
      expect(net.calls).toHaveLength(0);
    });
  });

  test("a failing channel never blocks the others and the call never throws", async () => {
    net.restore();
    net = mockFetch((url) => {
      if (url.includes("telegram")) throw new Error("socket hang up https://api.telegram.org/bottg-test-token/sendMessage");
      return new Response("{}", { status: 200 });
    });
    const logged: string[] = [];
    const origError = console.error;
    const origWarn = console.warn;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await inRolledBackTx(async ({ tx, user }) => {
        await putSettings(tx, user.id, { notificationsEnabled: true, notifyOnPublishFailure: true, telegramChatId: "42", discordWebhookUrl: DISCORD });
        await expect(sendUserNotification(tx, user.id, "publishFailure", { title: "T", error: "x" })).resolves.toBeUndefined();
        expect(net.calls.some((c) => c.url === DISCORD)).toBe(true);
      });
    } finally {
      console.error = origError;
      console.warn = origWarn;
    }
    expect(logged.join("\n")).not.toContain("tg-test-token"); // secrets never reach the logs
  });

  test("swallows database errors", async () => {
    const brokenDb = { select: () => { throw new Error("db down"); } } as never;
    await expect(sendUserNotification(brokenDb, "00000000-0000-4000-8000-000000000000", "publishSuccess", {})).resolves.toBeUndefined();
  });

  test("metadataReady variants and weekly digest wording", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await putSettings(tx, user.id, { notificationsEnabled: true, notifyOnMetadataReady: true, notifyOnWeeklyDigest: true, telegramChatId: "42" });
      await sendUserNotification(tx, user.id, "metadataReady", { title: "V", status: "failed", error: "nope" });
      await sendUserNotification(tx, user.id, "metadataReady", { title: "V", kind: "videoGenerated", withMetadata: true });
      await sendUserNotification(tx, user.id, "weeklyDigest", { videosPublished: 3, totalViews: 1234, topVideoTitle: "Top", topVideoViews: 99 });
      const texts = net.calls.map((c) => String(body(c).text));
      expect(texts[0]).toContain("Metadata failed");
      expect(texts[1]).toContain("Video generated");
      expect(texts[2]).toContain("published 3 videos");
      expect(texts[2]).toContain("1,234");
    });
  });
});
