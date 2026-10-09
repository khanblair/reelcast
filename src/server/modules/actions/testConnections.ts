// Port of convex/actions/testConnections.ts. Export ONLY rpc definitions from this file.
// All three resolve to { success, error? } (never throw for a failed check) so the settings page can
// show the reason inline. Everything is scoped to the caller; no secret is ever echoed back.
import { eq } from "drizzle-orm";
import { settings } from "@/db/schema";
import { isValidDiscordWebhook, sendDiscordMessage, sendTelegramMessage } from "@/server/lib/notify";
import { getPrimaryChannelRow, getValidAccessToken } from "@/server/lib/youtube/tokens";
import { safeMessage } from "@/server/lib/generation/common";
import { action } from "../../rpc/define";

export const testYoutube = action({
  handler: async (ctx): Promise<{ success: boolean; channelName?: string; error?: string }> => {
    const { db, userId } = ctx;
    const row = await getPrimaryChannelRow(db, userId);
    if (!row) return { success: false, error: "YouTube account is not connected." };

    let accessToken: string;
    try {
      ({ accessToken } = await getValidAccessToken(db, row.id));
    } catch (e) {
      return { success: false, error: `Token refresh failed: ${safeMessage(e, 200)}` };
    }

    try {
      const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { success: false, error: `YouTube API error: ${safeMessage(body.error?.message ?? `HTTP ${res.status}`, 200)}` };
      }
      const data = (await res.json()) as { items?: { snippet?: { title?: string } }[] };
      return { success: true, channelName: data.items?.[0]?.snippet?.title ?? "Unknown channel" };
    } catch (e) {
      return { success: false, error: e instanceof Error && e.name === "TimeoutError" ? "YouTube request timed out." : "Network error." };
    }
  },
});

export const testDiscord = action({
  handler: async (ctx): Promise<{ success: boolean; error?: string }> => {
    const [s] = await ctx.db.select({ url: settings.discordWebhookUrl }).from(settings).where(eq(settings.userId, ctx.userId)).limit(1);
    if (!s?.url) return { success: false, error: "Discord webhook is not connected." };
    // SSRF guard: only Discord's own https webhook endpoints are ever fetched from the server.
    if (!isValidDiscordWebhook(s.url)) return { success: false, error: "Discord webhook URL is not valid." };
    const r = await sendDiscordMessage(s.url, "✅ **ReelCast** — test message. Your Discord notifications are working!");
    return r.ok ? { success: true } : { success: false, error: r.error ?? "Discord request failed." };
  },
});

export const testTelegram = action({
  handler: async (ctx): Promise<{ success: boolean; error?: string }> => {
    const [s] = await ctx.db.select({ chatId: settings.telegramChatId }).from(settings).where(eq(settings.userId, ctx.userId)).limit(1);
    if (!s?.chatId) return { success: false, error: "Telegram chat ID is not connected." };
    const r = await sendTelegramMessage(s.chatId, "✅ ReelCast test message — your Telegram notifications are working!");
    return r.ok ? { success: true } : { success: false, error: r.error ?? "Telegram API error." };
  },
});
