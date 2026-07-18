"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api } from "../_generated/api";

export const sendNotification = action({
  args: { 
    userId: v.id("users"), 
    message: v.string() 
  },
  handler: async (ctx, args) => {
    // 1. Fetch user settings
    const userSettings = await ctx.runQuery(api.settings.getByUserId, { userId: args.userId });
    
    if (!userSettings || !userSettings.notificationsEnabled) return;

    const tasks: Promise<unknown>[] = [];

    // Telegram
    if (userSettings.telegramChatId) {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      if (botToken) {
        tasks.push(
          fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: userSettings.telegramChatId, text: args.message }),
          }).catch(() => {})
        );
      }
    }

    // Discord
    if ((userSettings as any).discordWebhookUrl) {
      tasks.push(
        fetch((userSettings as any).discordWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: args.message }),
        }).catch(() => {})
      );
    }

    await Promise.all(tasks);
  },
});
