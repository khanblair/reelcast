"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { api, internal } from "../_generated/api";

export const chat = action({
  args: { message: v.string(), sessionId: v.id("aiSessions") },
  handler: async (ctx, args) => {
    // 1. Get current user
    const user = await ctx.runQuery(api.users.current);
    if (!user) throw new Error("Unauthenticated");

    // 2. Enforce plan gate — Free users have no AI assistant access
    const plan = (user as any).plan ?? "free";
    if (plan === "free") {
      return { error: "plan_limit" } as const;
    }

    // 3. Load platform settings for DeepSeek key, and user settings for context
    const [platformSettings, settings] = await Promise.all([
      ctx.runQuery(internal.admin.platformSettings.getInternal),
      ctx.runQuery(api.settings.get),
    ]);
    const deepseekApiKey = platformSettings?.deepseekApiKey as string | undefined;
    if (!deepseekApiKey) {
      return { error: "no_api_key" } as const;
    }

    // 4. Consume AI message quota (atomic check + increment)
    let usageResult: { used: number; limit: number };
    try {
      usageResult = await ctx.runMutation(internal.usageLedger.internalConsumeQuota, {
        userId: (user as any)._id,
        field: "aiMessagesUsed",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.startsWith("PLAN_LIMIT_EXCEEDED")) {
        return { error: "plan_limit" } as const;
      }
      throw err;
    }

    // 5. Persist the incoming user message
    await ctx.runMutation(api.aiMessages.append, {
      sessionId: args.sessionId,
      role: "user",
      content: args.message,
    });

    // 6. Fetch conversation history for this session
    const conversationHistory = await ctx.runQuery(api.aiMessages.getContext, {
      sessionId: args.sessionId,
    });

    // 7. Build a rich context snapshot from the user's library, settings, and analytics
    const [videos, analyticsRows] = await Promise.all([
      ctx.runQuery(api.videos.list),
      ctx.runQuery(internal.analytics.getRecentForUser, { userId: (user as any)._id, limit: 20 }).catch(() => []),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const vid of videos) {
      statusCounts[vid.status] = (statusCounts[vid.status] ?? 0) + 1;
    }

    const recentVideos = videos.slice(0, 10).map((vid) => ({
      title: vid.title,
      tags: vid.tags ?? [],
      status: vid.status,
    }));

    // Summarise analytics for context
    let analyticsContext: Record<string, unknown> | null = null;
    if (analyticsRows && analyticsRows.length > 0) {
      const totalViews = analyticsRows.reduce((s: number, r: any) => s + (r.views ?? 0), 0);
      const avgCtr = analyticsRows.reduce((s: number, r: any) => s + (r.ctr ?? 0), 0) / analyticsRows.length;
      const topByViews = [...analyticsRows]
        .sort((a: any, b: any) => (b.views ?? 0) - (a.views ?? 0))
        .slice(0, 3)
        .map((r: any) => ({ youtubeVideoId: r.youtubeVideoId, views: r.views, ctr: r.ctr }));
      analyticsContext = {
        totalViewsRecent: totalViews,
        avgCtr: Math.round(avgCtr * 1000) / 1000,
        topPerformers: topByViews,
        videosWithData: analyticsRows.length,
      };
    }

    // Current time in EAT (UTC+3)
    const nowEAT = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const currentTime = nowEAT.toISOString().replace("T", " ").substring(0, 19);

    const contextData = JSON.stringify({
      videoStatusCounts: statusCounts,
      recentVideos,
      analytics: analyticsContext,
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

    // Build soft-warning note if the user is at 80%+ of their message cap
    const warningNote = usageResult.used / usageResult.limit >= 0.8
      ? `\n\n[SYSTEM: After your response, add a single line: "Note: ${usageResult.limit - usageResult.used} AI message${usageResult.limit - usageResult.used === 1 ? "" : "s"} remaining this month."]`
      : "";

    const systemPrompt =
      `You are an AI assistant for Reelcast, a YouTube publishing platform. ` +
      `You help the user manage their video library, publishing schedule, and content strategy. ` +
      `You have access to the user's data: ${contextData}. ` +
      `Current time: ${currentTime} EAT (UTC+3, Kampala). ` +
      `IMPORTANT FORMATTING RULES: ` +
      `Never use emojis. Do not include any emoji characters anywhere in your responses. ` +
      `Use markdown for formatting: **bold**, *italic*, bullet lists with -, numbered lists, ` +
      `tables with | syntax, code blocks with \`\`\`, and headings with ## when appropriate. ` +
      `Keep responses concise and actionable.` +
      warningNote;

    // Build the history slice to send — exclude the message we just saved
    const historyMessages = conversationHistory
      .slice(0, -1)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // 8. Call DeepSeek API
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

    // 9. Parse the response
    const data = (await deepseekResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const responseText = data.choices?.[0]?.message?.content;
    if (!responseText) throw new Error("DeepSeek returned no response content");

    // 10. Persist the assistant reply
    await ctx.runMutation(api.aiMessages.append, {
      sessionId: args.sessionId,
      role: "assistant",
      content: responseText,
    });

    // 11. Update session lastMessageAt
    await ctx.runMutation(api.aiSessions.touch, { sessionId: args.sessionId });

    return { response: responseText };
  },
});
