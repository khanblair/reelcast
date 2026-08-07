"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";

/**
 * AI Assistant chat action — powered by DeepSeek.
 *
 * Requires the user to have saved their own DeepSeek API key in settings
 * (BYOK model). Returns { error: "no_api_key" } if not configured.
 */
export const chat = action({
  args: { message: v.string(), sessionId: v.id("aiSessions") },
  handler: async (ctx, args) => {
    // 1. Get current user
    const user = await ctx.runQuery(api.users.current);
    if (!user) throw new Error("Unauthenticated");

    // 2. Load platform settings for DeepSeek key, and user settings for context
    const [platformSettings, settings] = await Promise.all([
      ctx.runQuery(internal.admin.platformSettings.getInternal),
      ctx.runQuery(api.settings.get),
    ]);
    const deepseekApiKey = platformSettings?.deepseekApiKey as string | undefined;
    if (!deepseekApiKey) {
      return { error: "no_api_key" } as const;
    }

    // 3. Persist the incoming user message
    await ctx.runMutation(api.aiMessages.append, {
      sessionId: args.sessionId,
      role: "user",
      content: args.message,
    });

    // 4. Fetch conversation history for this session
    const conversationHistory = await ctx.runQuery(api.aiMessages.getContext, {
      sessionId: args.sessionId,
    });

    // 5. Build a rich context snapshot from the user's library and settings
    const videos = await ctx.runQuery(api.videos.list);

    const statusCounts: Record<string, number> = {};
    for (const vid of videos) {
      statusCounts[vid.status] = (statusCounts[vid.status] ?? 0) + 1;
    }

    const recentVideos = videos.slice(0, 10).map((vid) => ({
      title: vid.title,
      tags: vid.tags ?? [],
      status: vid.status,
    }));

    // Current time in EAT (UTC+3)
    const nowEAT = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const currentTime = nowEAT.toISOString().replace("T", " ").substring(0, 19);

    const contextData = JSON.stringify({
      videoStatusCounts: statusCounts,
      recentVideos,
      settings: {
        aiTone: settings?.aiTone,
        aiNiche: settings?.aiNiche,
        aiTargetAudience: settings?.aiTargetAudience,
        aiBrandVoice: settings?.aiBrandVoice,
        autoPublishEnabled: settings?.autoPublishEnabled,
        autoPublishNextAt: settings?.autoPublishNextAt,
        autoPublishCount: settings?.autoPublishCount,
      },
    });

    const systemPrompt =
      `You are an AI assistant for Reelcast, a YouTube publishing platform. ` +
      `You help the user manage their video library, publishing schedule, and content strategy. ` +
      `You have access to the user's data: ${contextData}. ` +
      `Current time: ${currentTime} EAT (UTC+3, Kampala). ` +
      `IMPORTANT FORMATTING RULES: ` +
      `Never use emojis. Do not include any emoji characters anywhere in your responses. ` +
      `Use markdown for formatting: **bold**, *italic*, bullet lists with -, numbered lists, ` +
      `tables with | syntax, code blocks with \`\`\`, and headings with ## when appropriate. ` +
      `Keep responses concise and actionable.`;

    // Build the history slice to send — exclude the message we just saved
    // (it is sent explicitly as the final "user" turn below) to avoid duplication.
    const historyMessages = conversationHistory
      .slice(0, -1)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // 6. Call DeepSeek API
    const deepseekResponse = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deepseekApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          ...historyMessages,
          { role: "user", content: args.message },
        ],
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    if (!deepseekResponse.ok) {
      const errText = await deepseekResponse.text();
      throw new Error(
        `DeepSeek API error: ${deepseekResponse.status} ${errText}`
      );
    }

    // 7. Parse the response
    const data = (await deepseekResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const responseText = data.choices?.[0]?.message?.content;
    if (!responseText) throw new Error("DeepSeek returned no response content");

    // 8. Persist the assistant reply
    await ctx.runMutation(api.aiMessages.append, {
      sessionId: args.sessionId,
      role: "assistant",
      content: responseText,
    });

    // 9. Update session lastMessageAt
    await ctx.runMutation(api.aiSessions.touch, { sessionId: args.sessionId });

    // 9. Return to caller
    return { response: responseText };
  },
});
