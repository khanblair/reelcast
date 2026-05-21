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
    
    // 2. Check if telegram is connected and notifications are enabled
    if (!userSettings || !userSettings.telegramChatId || !userSettings.notificationsEnabled) {
      return;
    }

    // 3. Simulate calling Telegram API
    console.log(`[MOCK TELEGRAM to ${userSettings.telegramChatId}]: ${args.message}`);
    
    // In production, you would fetch from `https://api.telegram.org/bot<BOT_TOKEN>/sendMessage`
    /*
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userSettings.telegramChatId,
        text: args.message,
      }),
    });
    */
  },
});
