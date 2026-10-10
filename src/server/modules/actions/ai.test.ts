/**
 * rpc actions of the AI runtime: aiAssistant, metadata, captions, thumbnails, content
 * intelligence, connection tests. External APIs (Gemini, DeepSeek, YouTube, Telegram, Discord) are
 * mocked; the database work is real and rolled back.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { aiMessages, aiSessions, tasks, videos, youtubeChannels, youtubeQuotaUsage } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { NonRetryableError } from "@/server/jobs/handlers"; // keep handlers.ts as the import entry (cycle)
import { META_JSON, geminiText, json, mkVideo, mockFetch, putSettings, setEnv, setPlan, setPlatformKeys, setUsage, usageCount } from "@/server/lib/generation/testkit";
import { callRpc, inRolledBackTx } from "@/server/testing";

setDefaultTimeout(120_000);
void NonRetryableError;

const CLOUD = "https://res.cloudinary.com/demo/video/upload/v1/clip.mp4";
let restoreEnv: () => void;
let net: ReturnType<typeof mockFetch>;
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  restoreEnv = setEnv({ GEMINI_API_KEY: undefined, TELEGRAM_BOT_TOKEN: "tg-test-token" });
  handler = () => new Response("not mocked", { status: 404 });
  net = mockFetch((url, init) => handler(url, init));
});
afterEach(() => {
  net.restore();
  restoreEnv();
});

const asPlan = <T extends { plan: string }>(u: T, plan: "free" | "pro" | "elite") => ({ ...u, plan });

async function mkSession(tx: Parameters<typeof setPlan>[0], userId: string) {
  const [s] = await tx.insert(aiSessions).values({ userId, title: "t" }).returning();
  return s;
}

describe("actions.aiAssistant.chat", () => {
  test("free plan is blocked before anything else happens", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "free");
      const s = await mkSession(tx, user.id);
      const out = await callRpc("actions.aiAssistant.chat", { message: "hi", sessionId: s.id }, { user: asPlan(user, "free"), tx });
      expect(out).toEqual({ error: "plan_limit" });
      expect(net.calls).toHaveLength(0);
      expect(await tx.select().from(aiMessages).where(eq(aiMessages.sessionId, s.id))).toHaveLength(0);
    });
  });

  test("session must exist and belong to the caller; no key reports no_api_key without charging", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      await putSettings(tx, user.id, {});
      await setPlatformKeys(tx, { deepseek: null });
      const pro = asPlan(user, "pro");
      await expect(callRpc("actions.aiAssistant.chat", { message: "hi", sessionId: "00000000-0000-4000-8000-0000000000aa" }, { user: pro, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const s = await mkSession(tx, user.id);
      const used0 = await usageCount(tx, user.id, "ai_messages_used");
      const out = await callRpc("actions.aiAssistant.chat", { message: "hi", sessionId: s.id }, { user: pro, tx });
      expect(out).toEqual({ error: "no_api_key" });
      expect(await usageCount(tx, user.id, "ai_messages_used")).toBe(used0);
      expect(net.calls).toHaveLength(0);
    });
  });

  test("answers with the user's own key, persists both messages server-side, meters one unit", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      await putSettings(tx, user.id, { deepseekApiKey: encryptSecret("sk-own-key-0123456789abcdef"), aiNiche: "cooking" });
      await setPlatformKeys(tx, { deepseek: "sk-platform-key-0123456789" });
      await mkVideo(tx, user.id, { title: "Pasta tips", status: "published" });
      const s = await mkSession(tx, user.id);
      // an earlier turn in the same session becomes history
      // (explicit times: inside a transaction now() is frozen, so default timestamps would tie)
      await tx.insert(aiMessages).values([
        { userId: user.id, sessionId: s.id, role: "user", content: "earlier question", createdAt: new Date(Date.now() - 7_200_000) },
        { userId: user.id, sessionId: s.id, role: "assistant", content: "earlier answer", createdAt: new Date(Date.now() - 7_100_000) },
      ]);
      const used0 = await usageCount(tx, user.id, "ai_messages_used");
      handler = (url) => (url.includes("api.deepseek.com") ? json({ choices: [{ message: { content: "Here is **advice**." } }] }) : new Response("", { status: 404 }));

      const out = await callRpc("actions.aiAssistant.chat", { message: "what next?", sessionId: s.id }, { user: asPlan(user, "pro"), tx });
      expect(out).toEqual({ response: "Here is **advice**." });

      const call = net.calls[0];
      expect((call.init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-own-key-0123456789abcdef"); // BYOK wins
      const sent = JSON.parse(String(call.init!.body)) as { messages: { role: string; content: string }[] };
      expect(sent.messages[0].role).toBe("system");
      expect(sent.messages[0].content).toContain("Pasta tips");
      expect(sent.messages[0].content).toContain("cooking");
      expect(sent.messages.slice(1).map((m) => m.content)).toEqual(["earlier question", "earlier answer", "what next?"]);

      const stored = await tx.select().from(aiMessages).where(eq(aiMessages.sessionId, s.id)).orderBy(asc(aiMessages.createdAt), asc(aiMessages.role));
      expect(stored.map((m) => m.content).sort()).toEqual(["Here is **advice**.", "earlier answer", "earlier question", "what next?"]);
      expect(stored.filter((m) => m.content === "what next?")[0].role).toBe("user");
      expect(stored.filter((m) => m.content === "Here is **advice**.")[0].role).toBe("assistant");
      expect(await usageCount(tx, user.id, "ai_messages_used")).toBe(used0 + 1);
    });
  });

  test("falls back to the platform key; a provider failure refunds the unit and keeps the user message", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      await putSettings(tx, user.id, {});
      await setPlatformKeys(tx, { deepseek: "sk-platform-key-0123456789" });
      const s = await mkSession(tx, user.id);
      const used0 = await usageCount(tx, user.id, "ai_messages_used");
      handler = () => new Response("boom sk-platform-key-0123456789", { status: 500 });
      const err = await callRpc("actions.aiAssistant.chat", { message: "hello", sessionId: s.id }, { user: asPlan(user, "pro"), tx }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "INTERNAL" });
      expect((net.calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-platform-key-0123456789");
      expect(String((err as Error).message)).not.toContain("sk-platform");
      expect(await usageCount(tx, user.id, "ai_messages_used")).toBe(used0);
      const stored = await tx.select().from(aiMessages).where(eq(aiMessages.sessionId, s.id));
      expect(stored.map((m) => m.role)).toEqual(["user"]);
    });
  });

  test("monthly cap reached -> plan_limit without calling the provider", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      await putSettings(tx, user.id, {});
      await setPlatformKeys(tx, { deepseek: "sk-platform-key-0123456789" });
      await setUsage(tx, user.id, "ai_messages_used", 200);
      const s = await mkSession(tx, user.id);
      const out = await callRpc("actions.aiAssistant.chat", { message: "hello", sessionId: s.id }, { user: asPlan(user, "pro"), tx });
      expect(out).toEqual({ error: "plan_limit" });
      expect(net.calls).toHaveLength(0);
    });
  });
});

describe("actions.metadata.generateForUpload", () => {
  const geminiOk = (url: string) => {
    if (url.includes(":generateContent")) return geminiText(META_JSON);
    if (url.includes("res.cloudinary.com")) return new Response(new Uint8Array([0xff, 0xd8]), { status: 200 });
    return new Response("", { status: 404 });
  };

  test("returns the Convex shape, saves, clears a queued schedule, meters once; other users' videos are NOT_FOUND", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: "gem-key" });
      await putSettings(tx, user.id, {});
      const v = await mkVideo(tx, user.id, { rawFileKey: CLOUD, status: "draft", metadataScheduledAt: new Date(Date.now() + 3_600_000) });
      await tx.insert(tasks).values({ kind: "metadata.generate", payload: { videoId: v.id }, dedupeKey: `metadata:${v.id}`, userId: user.id });
      const used0 = await usageCount(tx, user.id, "metadata_generated");
      handler = geminiOk;

      const out = await callRpc("actions.metadata.generateForUpload", { videoId: v.id }, { user, tx });
      expect(out).toEqual({ title: "Generated Title", description: "Generated description.", tags: ["a", "b"] });
      const after = (await tx.select().from(videos).where(eq(videos.id, v.id)))[0];
      expect(after).toMatchObject({ aiTitle: "Generated Title", status: "draft" });
      expect(after.metadataScheduledAt).toBeNull();
      const t = await tx.select().from(tasks).where(eq(tasks.dedupeKey, `metadata:${v.id}`));
      expect(t[0].status).toBe("cancelled");
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0 + 1);

      await expect(callRpc("actions.metadata.generateForUpload", { videoId: "00000000-0000-4000-8000-0000000000aa" }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  test("no Gemini key: BAD_REQUEST and nothing is charged", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: null });
      const v = await mkVideo(tx, user.id, { rawFileKey: CLOUD });
      const used0 = await usageCount(tx, user.id, "metadata_generated");
      await expect(callRpc("actions.metadata.generateForUpload", { videoId: v.id }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0);
    });
  });

  test("plan limit surfaces the friendly message with the PLAN_LIMIT_EXCEEDED code", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: "gem-key" });
      await setPlan(tx, user.id, "free");
      await setUsage(tx, user.id, "metadata_generated", 5);
      const v = await mkVideo(tx, user.id, { rawFileKey: CLOUD });
      const err = await callRpc("actions.metadata.generateForUpload", { videoId: v.id }, { user: asPlan(user, "free"), tx }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "PLAN_LIMIT_EXCEEDED", message: "Metadata generation limit reached for your plan. Upgrade to regenerate more videos." });
      expect(net.calls).toHaveLength(0);
    });
  });

  test("Gemini failure refunds the unit; unavailable frames hand over to the background task", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: "gem-key" });
      await putSettings(tx, user.id, {});
      const v = await mkVideo(tx, user.id, { rawFileKey: CLOUD, aiTitle: "Current" });
      const used0 = await usageCount(tx, user.id, "metadata_generated");

      handler = (url) => (url.includes(":generateContent") ? new Response("down", { status: 503 }) : geminiOk(url));
      await expect(callRpc("actions.metadata.generateForUpload", { videoId: v.id }, { user, tx })).rejects.toMatchObject({ code: "INTERNAL" });
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0);

      handler = (url) => (url.includes("res.cloudinary.com") ? new Response("", { status: 404 }) : geminiOk(url)); // no frames
      const out = await callRpc("actions.metadata.generateForUpload", { videoId: v.id, humanize: true }, { user, tx });
      expect(out).toMatchObject({ title: "Current", description: "", queued: true });
      const queued = await tx.select().from(tasks).where(eq(tasks.dedupeKey, `metadata:${v.id}`));
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ kind: "metadata.generate", status: "pending", userId: user.id });
      expect(queued[0].payload).toMatchObject({ videoId: v.id, mode: "manual", quotaConsumed: true, humanize: true });
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0 + 1); // unit travels with the task
    });
  });
});

describe("actions.generateThumbnail / generateCaptions", () => {
  test("thumbnail: Gemini picks a frame, URL is built from it and stored; non-Cloudinary hosts are refused", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: "gem-key" });
      const v = await mkVideo(tx, user.id, { rawFileKey: CLOUD });
      handler = (url) => {
        if (url.includes(":generateContent")) return geminiText("2");
        if (url.includes("res.cloudinary.com")) return new Response(new Uint8Array([1, 2]), { status: 200 });
        return new Response("", { status: 404 });
      };
      const out = (await callRpc("actions.generateThumbnail.generate", { videoId: v.id }, { user, tx })) as { thumbnailUrl: string };
      expect(out.thumbnailUrl).toBe("https://res.cloudinary.com/demo/video/upload/so_40p,w_1280,h_720,c_fill,e_sharpen,e_vibrance:50/v1/clip.jpg");
      expect((await tx.select().from(videos).where(eq(videos.id, v.id)))[0].thumbnailGeneratedUrl).toBe(out.thumbnailUrl);

      const evil = await mkVideo(tx, user.id, { rawFileKey: "http://169.254.169.254/x.mp4" });
      await expect(callRpc("actions.generateThumbnail.generate", { videoId: evil.id }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(net.calls.some((c) => c.url.includes("169.254"))).toBe(false);
    });
  });

  test("captions: fences stripped, WEBVTT header enforced, stored on the owner's video", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: "gem-key" });
      const v = await mkVideo(tx, user.id, { rawFileKey: CLOUD, duration: 5 }); // short clip: still >= 2 frames
      handler = (url) => {
        if (url.includes(":generateContent")) return geminiText("```vtt\n00:00:00.000 --> 00:00:02.000\nHello\n```");
        if (url.includes("res.cloudinary.com")) return new Response(new Uint8Array([1, 2]), { status: 200 });
        return new Response("", { status: 404 });
      };
      const out = (await callRpc("actions.generateCaptions.generate", { videoId: v.id }, { user, tx })) as { captionsVtt: string };
      expect(out.captionsVtt.startsWith("WEBVTT")).toBe(true);
      expect(out.captionsVtt).toContain("Hello");
      expect(out.captionsVtt).not.toContain("```");
      expect(net.calls.filter((c) => c.url.includes("res.cloudinary.com"))).toHaveLength(2);
      expect((await tx.select().from(videos).where(eq(videos.id, v.id)))[0].captionsVtt).toBe(out.captionsVtt);
    });
  });
});

describe("actions.generateThumbnail / generateCaptions: metering", () => {
  // Both actions call Gemini with video frames, exactly like metadata.generateForUpload, so they spend the same
  // `metadataGenerated` unit (free: 5 / month, pro and elite: unlimited).
  const FRAME_AI_MESSAGE = "AI limit reached for your plan: captions, thumbnails and metadata generation share one monthly allowance. Upgrade for more.";
  const gemCalls = () => net.calls.filter((c) => c.url.includes(":generateContent")).length;
  const cloudCalls = () => net.calls.filter((c) => c.url.includes("res.cloudinary.com")).length;
  const frame = () => new Response(new Uint8Array([1, 2]), { status: 200 });

  const endpoints = [
    { name: "thumbnail", path: "actions.generateThumbnail.generate", reply: () => geminiText("1") },
    { name: "captions", path: "actions.generateCaptions.generate", reply: () => geminiText("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHi") },
  ] as const;

  async function setup(tx: Parameters<typeof setPlan>[0], user: { id: string }, plan: "free" | "pro" | "elite", used: number) {
    await setPlatformKeys(tx, { gemini: "gem-key" });
    await setPlan(tx, user.id, plan);
    await setUsage(tx, user.id, "metadata_generated", used);
    return mkVideo(tx, user.id, { rawFileKey: CLOUD, duration: 5 });
  }

  for (const ep of endpoints) {
    test(`${ep.name}: at the plan limit it is rejected before any network call and nothing is charged`, async () => {
      await inRolledBackTx(async ({ tx, user }) => {
        const v = await setup(tx, user, "free", 5);
        handler = (url) => (url.includes(":generateContent") ? ep.reply() : frame());
        const err = await callRpc(ep.path, { videoId: v.id }, { user: asPlan(user, "free"), tx }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "PLAN_LIMIT_EXCEEDED", message: FRAME_AI_MESSAGE });
        expect(gemCalls()).toBe(0);
        expect(cloudCalls()).toBe(0); // the gate sits before the frame fetches, too
        expect(await usageCount(tx, user.id, "metadata_generated")).toBe(5);
        const row = (await tx.select().from(videos).where(eq(videos.id, v.id)))[0];
        expect(row.captionsVtt).toBeNull();
        expect(row.thumbnailGeneratedUrl).toBeNull();
      });
    });

    test(`${ep.name}: under the limit it succeeds, calls Gemini once and spends exactly one unit`, async () => {
      await inRolledBackTx(async ({ tx, user }) => {
        const v = await setup(tx, user, "free", 4);
        handler = (url) => (url.includes(":generateContent") ? ep.reply() : frame());
        await callRpc(ep.path, { videoId: v.id }, { user: asPlan(user, "free"), tx });
        expect(gemCalls()).toBe(1);
        expect(await usageCount(tx, user.id, "metadata_generated")).toBe(5);
      });
    });

    test(`${ep.name}: pro and elite are never blocked by it (unlimited allowance), but the unit is still counted`, async () => {
      await inRolledBackTx(async ({ tx, user }) => {
        const v = await setup(tx, user, "pro", 5000);
        handler = (url) => (url.includes(":generateContent") ? ep.reply() : frame());
        await callRpc(ep.path, { videoId: v.id }, { user: asPlan(user, "pro"), tx });
        expect(gemCalls()).toBe(1);
        expect(await usageCount(tx, user.id, "metadata_generated")).toBe(5001);
      });
    });

    test(`${ep.name}: a missing Gemini key, a foreign host and someone else's video cost nothing`, async () => {
      await inRolledBackTx(async ({ tx, user, makeUser }) => {
        const v = await setup(tx, user, "free", 1);
        await setPlatformKeys(tx, { gemini: null });
        await expect(callRpc(ep.path, { videoId: v.id }, { user: asPlan(user, "free"), tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await setPlatformKeys(tx, { gemini: "gem-key" });
        const evil = await mkVideo(tx, user.id, { rawFileKey: "https://example.com/x.mp4" });
        await expect(callRpc(ep.path, { videoId: evil.id }, { user: asPlan(user, "free"), tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        const other = await makeUser();
        const theirs = await mkVideo(tx, other.id, { rawFileKey: CLOUD });
        await expect(callRpc(ep.path, { videoId: theirs.id }, { user: asPlan(user, "free"), tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(await usageCount(tx, user.id, "metadata_generated")).toBe(1);
        expect(await usageCount(tx, other.id, "metadata_generated")).toBe(0);
      });
    });
  }

  test("captions: a Gemini failure and an unreadable video both refund the unit", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await setup(tx, user, "free", 2);
      handler = (url) => (url.includes(":generateContent") ? new Response("down", { status: 503 }) : frame());
      await expect(callRpc("actions.generateCaptions.generate", { videoId: v.id }, { user: asPlan(user, "free"), tx })).rejects.toMatchObject({ code: "INTERNAL" });
      expect(gemCalls()).toBeGreaterThan(0);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(2);

      net.calls.length = 0;
      handler = () => new Response("", { status: 404 }); // no frames at all
      await expect(callRpc("actions.generateCaptions.generate", { videoId: v.id }, { user: asPlan(user, "free"), tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(gemCalls()).toBe(0);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(2);
    });
  });

  test("thumbnail: when Gemini fails or there are no frames the default frame is still returned and the unit is refunded", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await setup(tx, user, "free", 2);
      const fallback = "https://res.cloudinary.com/demo/video/upload/so_25p,w_1280,h_720,c_fill,e_sharpen,e_vibrance:50/v1/clip.jpg";

      handler = (url) => (url.includes(":generateContent") ? new Response("down", { status: 503 }) : frame());
      expect(await callRpc("actions.generateThumbnail.generate", { videoId: v.id }, { user: asPlan(user, "free"), tx })).toEqual({ thumbnailUrl: fallback });
      expect(gemCalls()).toBeGreaterThan(0);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(2);

      net.calls.length = 0;
      handler = () => new Response("", { status: 404 });
      expect(await callRpc("actions.generateThumbnail.generate", { videoId: v.id }, { user: asPlan(user, "free"), tx })).toEqual({ thumbnailUrl: fallback });
      expect(gemCalls()).toBe(0);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(2);
    });
  });

  test("thumbnail: a Gemini reply that is not a frame index still spent the call, so the unit stays spent", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await setup(tx, user, "free", 2);
      handler = (url) => (url.includes(":generateContent") ? geminiText("the third one") : frame());
      await callRpc("actions.generateThumbnail.generate", { videoId: v.id }, { user: asPlan(user, "free"), tx });
      expect(gemCalls()).toBe(1);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(3);
    });
  });

  test("captions, thumbnails and metadata draw from one allowance", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await setup(tx, user, "free", 3);
      const free = asPlan(user, "free");
      handler = (url) => (url.includes(":generateContent") ? geminiText("1") : frame());
      await callRpc("actions.generateThumbnail.generate", { videoId: v.id }, { user: free, tx }); // 4
      await callRpc("actions.generateCaptions.generate", { videoId: v.id }, { user: free, tx }); // 5
      await expect(callRpc("actions.generateThumbnail.generate", { videoId: v.id }, { user: free, tx })).rejects.toMatchObject({ code: "PLAN_LIMIT_EXCEEDED" });
      await expect(callRpc("actions.metadata.generateForUpload", { videoId: v.id }, { user: free, tx })).rejects.toMatchObject({ code: "PLAN_LIMIT_EXCEEDED" });
    });
  });
});

describe("actions.testConnections", () => {
  test("Discord: SSRF guard; Telegram: success and failure; nothing configured is reported", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await putSettings(tx, user.id, {});
      expect(await callRpc("actions.testConnections.testDiscord", {}, { user, tx })).toEqual({ success: false, error: "Discord webhook is not connected." });
      expect(await callRpc("actions.testConnections.testTelegram", {}, { user, tx })).toEqual({ success: false, error: "Telegram chat ID is not connected." });

      await putSettings(tx, user.id, { discordWebhookUrl: "https://evil.example.com/api/webhooks/1/x", telegramChatId: "42" });
      expect(await callRpc("actions.testConnections.testDiscord", {}, { user, tx })).toMatchObject({ success: false });
      expect(net.calls).toHaveLength(0);

      handler = () => json({ ok: true });
      expect(await callRpc("actions.testConnections.testTelegram", {}, { user, tx })).toEqual({ success: true });
      handler = () => json({ ok: false, description: "chat not found" }, 400);
      expect(await callRpc("actions.testConnections.testTelegram", {}, { user, tx })).toEqual({ success: false, error: "chat not found" });

      await putSettings(tx, user.id, { discordWebhookUrl: "https://discord.com/api/webhooks/1/x" });
      handler = () => new Response("", { status: 204 });
      expect(await callRpc("actions.testConnections.testDiscord", {}, { user, tx })).toEqual({ success: true });
      expect(await callRpc("actions.testConnections.testYoutube", {}, { user, tx })).toEqual({ success: false, error: "YouTube account is not connected." });
    });
  });
});

describe("actions.testConnections.testYoutube", () => {
  test("reports the channel name, upstream errors and unusable tokens without leaking them", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
      await tx.insert(youtubeChannels).values({
        userId: user.id,
        channelId: `UC_test_${Math.random().toString(36).slice(2, 12)}`,
        accessToken: encryptSecret("ya29.secret-access"),
        refreshToken: encryptSecret("1//refresh"),
        tokenExpiry: new Date(Date.now() + 3_600_000),
        isPrimary: true,
      });
      handler = () => json({ items: [{ snippet: { title: "My Channel" } }] });
      expect(await callRpc("actions.testConnections.testYoutube", {}, { user, tx })).toEqual({ success: true, channelName: "My Channel" });
      expect((net.calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer ya29.secret-access");

      handler = () => json({ error: { message: "quotaExceeded" } }, 403);
      expect(await callRpc("actions.testConnections.testYoutube", {}, { user, tx })).toEqual({ success: false, error: "YouTube API error: quotaExceeded" });

      // expired token + refresh rejected by Google (invalid_grant): readable error, no crash
      await tx.update(youtubeChannels).set({ tokenExpiry: new Date(Date.now() - 1000) }).where(eq(youtubeChannels.userId, user.id));
      const undoEnv = setEnv({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret" });
      try {
        handler = () => json({ error: "invalid_grant" }, 400);
        const out = (await callRpc("actions.testConnections.testYoutube", {}, { user, tx })) as { success: boolean; error?: string };
        expect(out.success).toBe(false);
        expect(out.error).toContain("Token refresh failed");
      } finally {
        undoEnv();
      }
    });
  });
});

describe("actions.contentIntelligence", () => {
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

  test("not connected -> empty results, no network", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
      expect(await callRpc("actions.contentIntelligence.getTrendingTopics", {}, { user, tx })).toEqual([]);
      expect(await callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "x" }, { user, tx })).toEqual([]);
      expect(await callRpc("actions.contentIntelligence.getContentGaps", {}, { user, tx })).toEqual({ gaps: [], competitorTopics: [], userTopics: [] });
      expect(net.calls).toHaveLength(0);
    });
  });

  test("trending / search record quota, gaps = trending tags the user has not covered; 401 marks the token expired", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
      const ch = await connect(tx, user.id);
      await mkVideo(tx, user.id, { status: "published", tags: ["Cooking"], aiTags: ["pasta"] });
      const q0 = await quota(tx, user.id);
      handler = (url) => {
        if (url.includes("chart=mostPopular")) {
          return json({ items: [
            { id: "v1", snippet: { title: "A", channelTitle: "C", tags: ["cooking", "travel"], publishedAt: "2026-01-01" }, statistics: { viewCount: "10", likeCount: "2" } },
            { id: "v2", snippet: { title: "B", channelTitle: "C", tags: ["Pasta", "gaming"] }, statistics: {} },
          ] });
        }
        if (url.includes("/search?")) return json({ items: [{ id: { videoId: "s1" }, snippet: { title: "Found", thumbnails: { medium: { url: "https://i.ytimg.com/x.jpg" } } } }] });
        return new Response("", { status: 404 });
      };
      const trending = (await callRpc("actions.contentIntelligence.getTrendingTopics", { regionCode: "ug", maxResults: 5 }, { user, tx })) as { videoId: string; viewCount: number }[];
      expect(trending.map((t) => t.videoId)).toEqual(["v1", "v2"]);
      expect(trending[0].viewCount).toBe(10);
      expect(net.calls[0].url).toContain("regionCode=UG");
      expect((net.calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer ya29.test-access");
      expect(await quota(tx, user.id)).toBe(q0 + 2);

      const found = (await callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "pasta" }, { user, tx })) as { videoId: string; thumbnailUrl: string }[];
      expect(found[0]).toMatchObject({ videoId: "s1", thumbnailUrl: "https://i.ytimg.com/x.jpg" });
      expect(await quota(tx, user.id)).toBe(q0 + 2 + 100);

      const gaps = (await callRpc("actions.contentIntelligence.getContentGaps", { competitorChannelIds: ["UCcompetitor_000000001"] }, { user, tx })) as { gaps: string[]; competitorTopics: string[]; userTopics: string[] };
      expect(gaps.gaps.sort()).toEqual(["gaming", "travel"]); // cooking / Pasta already covered (case-insensitive)
      expect(gaps.competitorTopics).toEqual(["Found"]);
      expect(gaps.userTopics.sort()).toEqual(["Cooking", "pasta"]);

      handler = () => new Response("", { status: 401 });
      expect(await callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "x" }, { user, tx })).toEqual([]);
      const row = (await tx.select().from(youtubeChannels).where(eq(youtubeChannels.id, ch.id)))[0];
      expect(row.oauthStatus).toBe("token_expired");
    });
  });

  test("input is validated (region code, keyword length, result cap)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("actions.contentIntelligence.getTrendingTopics", { regionCode: "USA" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("actions.contentIntelligence.getTrendingTopics", { maxResults: 5000 }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("actions.contentIntelligence.searchByKeyword", { keyword: "" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });
});
