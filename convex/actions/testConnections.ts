"use node";

import { action } from "../_generated/server";
import { getCurrentUserOrThrow } from "../lib/auth";
import { api, internal } from "../_generated/api";
import { refreshYouTubeToken } from "../lib/youtube";

export const testYoutube = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; channelName?: string; error?: string }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});

    if (!user) return { success: false, error: "User not found." };
    if (!user.youtubeConnected || !user.youtubeAccessToken) {
      return { success: false, error: "YouTube account is not connected." };
    }

    // Refresh if expired or within 5 minutes of expiry
    let accessToken = user.youtubeAccessToken;
    const expiry = user.youtubeTokenExpiry ?? 0;
    if (Date.now() > expiry - 5 * 60 * 1000) {
      if (!user.youtubeRefreshToken) {
        return { success: false, error: "Token expired and no refresh token available. Please reconnect YouTube." };
      }
      try {
        const refreshed = await refreshYouTubeToken(user.youtubeRefreshToken);
        accessToken = refreshed.accessToken;
        await ctx.runMutation(internal.users.internalUpdateYoutubeTokens, {
          userId: user._id,
          accessToken: refreshed.accessToken,
          expiresIn: refreshed.expiresIn,
        });
      } catch (err) {
        return { success: false, error: `Token refresh failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    try {
      const res = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
        return { success: false, error: `YouTube API error: ${msg}` };
      }
      const data = await res.json() as { items?: { snippet?: { title?: string } }[] };
      const channelName = data.items?.[0]?.snippet?.title ?? "Unknown channel";
      return { success: true, channelName };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Network error." };
    }
  },
});

export const testDiscord = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; error?: string }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user) return { success: false, error: "User not found." };

    const settings = await ctx.runQuery(api.settings.getByUserId, { userId: user._id });
    if (!settings?.discordWebhookUrl) {
      return { success: false, error: "Discord webhook is not connected." };
    }

    try {
      const res = await fetch(settings.discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "✅ **ReelCast** — test message. Your Discord notifications are working!",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { success: false, error: `Discord API error: ${res.status}${text ? ` — ${text}` : ""}` };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Network error." };
    }
  },
});

export const testTelegram = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; error?: string }> => {
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user) return { success: false, error: "User not found." };

    const settings = await ctx.runQuery(api.settings.getByUserId, { userId: user._id });
    if (!settings?.telegramChatId) {
      return { success: false, error: "Telegram chat ID is not connected." };
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return { success: false, error: "Bot token not configured on server." };

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: settings.telegramChatId,
            text: "✅ ReelCast test message — your Telegram notifications are working!",
          }),
        }
      );
      const body = await res.json() as { ok: boolean; description?: string };
      if (!body.ok) return { success: false, error: body.description ?? "Telegram API error." };
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Network error." };
    }
  },
});
