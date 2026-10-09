/**
 * Outbound user notifications: Telegram, Discord webhook and email (BYOK Resend).
 * Replaces convex/actions/telegram.ts `sendNotification` + the email fan-out.
 *
 *   sendUserNotification(db, userId, event, data): Promise<void>   -- NEVER throws.
 *
 * Gating (all must hold for a channel to fire):
 *   - the user has a settings row with `notificationsEnabled` (master switch);
 *   - the per-event toggle is on (`notifyOnPublishSuccess`, ...). An UNSET toggle counts as off,
 *     exactly like the notifications settings page renders it (`?? false`);
 *   - the channel itself is configured (Telegram chat id + platform bot token, Discord webhook,
 *     or `emailNotificationsEnabled` + the user's decrypted Resend key).
 * Channels are isolated (Promise.allSettled): one failing never blocks the others. Failures are
 * logged WITHOUT URLs, tokens or keys (the Telegram bot token is part of its URL).
 *
 * `data` per event (extra keys are ignored; every key is optional so callers cannot crash it):
 *   publishSuccess: { title, url?, youtubeVideoId?, thumbnailUrl? }
 *   publishFailure: { title, error?, attemptsLabel? }
 *   metadataReady : { title, videoId?, status?: "ready" | "failed", error?, kind?: "videoGenerated", withMetadata? }
 *                   (kind "videoGenerated" = a Veo video finished; it rides on the metadata-ready toggle)
 *   weeklyDigest  : { videosPublished, totalViews?, topVideoTitle?, topVideoViews? }
 *   storageWarning: { message?, titles?: string[] }
 * The user-defined `{{title}}` / `{{url}}` templates apply to publishSuccess only (that is the only
 * event that has a URL; the settings page describes them as the "published" message format).
 */
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { settings, users } from "@/db/schema";
import { decryptSecret } from "@/server/crypto";
import {
  metadataFailedEmail,
  metadataReadyEmail,
  publishFailureEmail,
  publishSuccessEmail,
  sendResendEmail,
  storageWarningEmail,
  videoGeneratedEmail,
  weeklyDigestEmail,
  type EmailContent,
} from "./email";

export type NotifyEvent = "publishSuccess" | "publishFailure" | "metadataReady" | "weeklyDigest" | "storageWarning";

type SettingsRow = typeof settings.$inferSelect;

const EVENT_TOGGLE: Record<NotifyEvent, keyof SettingsRow> = {
  publishSuccess: "notifyOnPublishSuccess",
  publishFailure: "notifyOnPublishFailure",
  metadataReady: "notifyOnMetadataReady",
  weeklyDigest: "notifyOnWeeklyDigest",
  storageWarning: "notifyOnStorageWarning",
};

const CHANNEL_TIMEOUT_MS = 10_000;
const TELEGRAM_MAX = 4096;
const DISCORD_MAX = 2000;

// ─── channel primitives (also used by the "test connection" actions) ─────────

/**
 * SSRF guard for user-supplied webhook URLs: https, Discord's own hosts, webhook path, no
 * embedded credentials, default port. Anything else must never be fetched from the server.
 */
export function isValidDiscordWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "discord.com" || u.hostname === "discordapp.com") &&
      u.pathname.startsWith("/api/webhooks/") &&
      u.username === "" &&
      u.password === "" &&
      u.port === ""
    );
  } catch {
    return false;
  }
}

export type ChannelResult = { ok: boolean; error?: string };

export async function sendTelegramMessage(chatId: string, text: string): Promise<ChannelResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return { ok: false, error: "Bot token not configured on server." };
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, TELEGRAM_MAX) }),
      signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
      redirect: "error",
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || body.ok === false) return { ok: false, error: body.description ?? `Telegram API error (${res.status}).` };
    return { ok: true };
  } catch (e) {
    // Do not include e.message verbatim: undici errors can embed the request URL (bot token).
    return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "Telegram request timed out." : "Network error." };
  }
}

export async function sendDiscordMessage(webhookUrl: string, text: string): Promise<ChannelResult> {
  if (!isValidDiscordWebhook(webhookUrl)) return { ok: false, error: "Invalid Discord webhook URL." };
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text.slice(0, DISCORD_MAX) }),
      signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `Discord API error: ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "Discord request timed out." : "Network error." };
  }
}

// ─── message building ────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Replace `{{title}}` / `{{url}}` (spaces inside the braces tolerated). Unknown placeholders are left alone. */
export function renderTemplate(template: string, vars: { title: string; url: string }): string {
  return template.replace(/\{\{\s*(title|url)\s*\}\}/g, (_m, k: "title" | "url") => vars[k]);
}

type Built = { text: string; email: EmailContent };

function build(event: NotifyEvent, data: Record<string, unknown>): Built {
  switch (event) {
    case "publishSuccess": {
      const title = str(data.title) ?? "Your video";
      const ytId = str(data.youtubeVideoId);
      const url = str(data.url) ?? (ytId ? `https://youtu.be/${ytId}` : "");
      return {
        text: `🎬 Published: "${title}" is now live on YouTube!${url ? `\n${url}` : ""}`,
        email: publishSuccessEmail({ title, url: url || "https://www.youtube.com/", thumbnailUrl: str(data.thumbnailUrl) }),
      };
    }
    case "publishFailure": {
      const title = str(data.title) ?? "Your video";
      const error = str(data.error) ?? "Unknown error";
      const attempts = str(data.attemptsLabel);
      return {
        text: `❌ Publish failed: "${title}"${attempts ? ` after ${attempts}` : ""}.\n\nReason: ${error}`,
        email: publishFailureEmail({ title, error }),
      };
    }
    case "metadataReady": {
      const title = str(data.title) ?? "Your video";
      const videoId = str(data.videoId);
      if (data.kind === "videoGenerated") {
        const withMetadata = data.withMetadata === true;
        return {
          text: `🎬 Video generated: "${title}" is ready${withMetadata ? ", with AI metadata," : ""} for review and publishing.`,
          email: videoGeneratedEmail({ title, videoId, withMetadata }),
        };
      }
      if (data.status === "failed") {
        const error = str(data.error) ?? "Unknown error";
        return {
          text: `❌ Metadata failed: "${title}" — ${error}. Video remains as draft.`,
          email: metadataFailedEmail({ title, error, videoId }),
        };
      }
      return {
        text: `✅ Metadata ready: "${title}" is now ready for YouTube publishing.`,
        email: metadataReadyEmail({ title, videoId }),
      };
    }
    case "weeklyDigest": {
      const videosPublished = num(data.videosPublished) ?? 0;
      const totalViews = num(data.totalViews);
      const topVideoTitle = str(data.topVideoTitle);
      const topVideoViews = num(data.topVideoViews);
      const label = videosPublished === 1 ? "video" : "videos";
      const lines = [
        `📊 Weekly digest: you published ${videosPublished} ${label} this week.`,
        totalViews !== undefined ? `Total views so far: ${totalViews.toLocaleString("en-US")}` : undefined,
        topVideoTitle ? `Top video: ${topVideoTitle}${topVideoViews !== undefined ? ` (${topVideoViews.toLocaleString("en-US")} views)` : ""}` : undefined,
      ].filter((l): l is string => Boolean(l));
      return { text: lines.join("\n"), email: weeklyDigestEmail({ videosPublished, totalViews, topVideoTitle, topVideoViews }) };
    }
    case "storageWarning": {
      const titles = Array.isArray(data.titles) ? data.titles.filter((t): t is string => typeof t === "string") : [];
      const message =
        str(data.message) ??
        (titles.length
          ? `⚠️ ${titles.length} video(s) have a missing storage file and were skipped:\n${titles.map((t) => `• ${t}`).join("\n")}\n\nRe-upload to publish.`
          : "⚠️ Storage warning: a video file is missing or storage is nearly full.");
      return { text: message, email: storageWarningEmail({ message }) };
    }
  }
}

function templateFor(event: NotifyEvent, data: Record<string, unknown>, template: string | null | undefined): string | null {
  if (event !== "publishSuccess" || !template?.trim()) return null;
  const ytId = str(data.youtubeVideoId);
  return renderTemplate(template, {
    title: str(data.title) ?? "Your video",
    url: str(data.url) ?? (ytId ? `https://youtu.be/${ytId}` : ""),
  });
}

// ─── fan-out ─────────────────────────────────────────────────────────────────

function decryptKey(blob: string | null): string | null {
  if (!blob) return null;
  try {
    return decryptSecret(blob);
  } catch {
    console.error("[notify] stored Resend key could not be decrypted");
    return null;
  }
}

export async function sendUserNotification(
  db: DbLike,
  userId: string,
  event: NotifyEvent,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.userId, userId)).limit(1);
    if (!row?.notificationsEnabled) return;
    if (!row[EVENT_TOGGLE[event]]) return;

    const built = build(event, data ?? {});
    const jobs: { name: string; run: () => Promise<ChannelResult> }[] = [];

    if (row.telegramChatId && process.env.TELEGRAM_BOT_TOKEN) {
      const text = templateFor(event, data, row.telegramMessageTemplate) ?? built.text;
      const chatId = row.telegramChatId;
      jobs.push({ name: "telegram", run: () => sendTelegramMessage(chatId, text) });
    }

    if (row.discordWebhookUrl) {
      if (isValidDiscordWebhook(row.discordWebhookUrl)) {
        const text = templateFor(event, data, row.discordMessageTemplate) ?? built.text;
        const url = row.discordWebhookUrl;
        jobs.push({ name: "discord", run: () => sendDiscordMessage(url, text) });
      } else {
        console.warn("[notify] skipped a Discord webhook that failed host validation");
      }
    }

    if (row.emailNotificationsEnabled && row.resendApiKey) {
      const apiKey = decryptKey(row.resendApiKey);
      if (apiKey) {
        jobs.push({
          name: "email",
          run: async () => {
            const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
            if (!u?.email) return { ok: false, error: "no recipient" };
            const r = await sendResendEmail({ apiKey, from: row.emailFromAddress, to: u.email, content: built.email });
            return { ok: r.sent, error: r.error };
          },
        });
      }
    }

    const results = await Promise.allSettled(jobs.map((j) => j.run()));
    results.forEach((r, i) => {
      const name = jobs[i].name;
      if (r.status === "rejected") console.error(`[notify] ${name} channel threw for event ${event}`);
      else if (!r.value.ok) console.warn(`[notify] ${name} channel failed for event ${event}: ${r.value.error ?? "unknown"}`);
    });
  } catch (e) {
    console.error(`[notify] ${event} failed:`, e instanceof Error ? e.name : "error");
  }
}
