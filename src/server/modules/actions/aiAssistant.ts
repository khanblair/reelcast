// Port of convex/actions/aiAssistant.ts. Export ONLY rpc definitions from this file.
//
// Keeps the Convex contract: resolves to { response } or { error: "plan_limit" | "no_api_key" } (the
// panel branches on those). The user message and the assistant reply are persisted HERE, server side,
// into the owner-checked session; the browser never writes ai_messages for a chat turn.
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/client";
import { aiMessages, aiSessions, settings, videoAnalytics, videos } from "@/db/schema";
import { decryptSecret } from "@/server/crypto";
import { safeMessage } from "@/server/lib/generation/common";
import { getPlatformKey } from "@/server/lib/platformKeys";
import { consumeQuota, refundQuota } from "@/server/lib/usage";
import { action } from "../../rpc/define";
import { RpcError, notFound } from "../../rpc/errors";

const HISTORY_LIMIT = 100;
const DEEPSEEK_TIMEOUT_MS = 40_000;
const MAX_MESSAGE_CHARS = 8_000;

type ChatResult = { response: string } | { error: "plan_limit" } | { error: "no_api_key" };

function isPlanLimit(e: unknown): boolean {
  return e instanceof RpcError && e.code === "PLAN_LIMIT_EXCEEDED";
}

/** What the chat reads from the caller's settings row (null when the user has none): the stored BYOK key + prompt context. */
type ChatSettings = {
  userId: string;
  deepseekApiKey: string | null;
  aiTone: string | null;
  aiNiche: string | null;
  aiTargetAudience: string | null;
  aiBrandVoice: string | null;
  autoPublishEnabled: boolean | null;
  autoPublishNextAt: Date | null;
  autoPublishCount: number | null;
} | null;

/** The user's own (BYOK) DeepSeek key wins; otherwise the platform key. null = none configured. */
async function resolveDeepseekKey(db: DbLike, storedUserKey: string | null | undefined): Promise<string | null> {
  if (storedUserKey) {
    try {
      const own = decryptSecret(storedUserKey);
      if (own) return own;
    } catch {
      console.error("[aiAssistant] stored DeepSeek key could not be decrypted; falling back to the platform key");
    }
  }
  return getPlatformKey(db, "deepseek");
}

export const chat = action({
  input: z.object({ message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS), sessionId: z.string().uuid() }),
  handler: async (ctx, args): Promise<ChatResult> => {
    const { db, userId, user } = ctx;

    // Free users have no AI assistant access (limit 0 in PLAN_LIMITS; checked up front like Convex).
    if ((user.plan ?? "free") === "free") return { error: "plan_limit" };

    // The session must belong to the caller (NOT_FOUND otherwise). The caller's settings row comes back on the same
    // row (one statement): it holds the BYOK key and is the prompt's settings context, so it is never read again.
    const [found] = await db
      .select({
        id: aiSessions.id,
        settings: {
          userId: settings.userId,
          deepseekApiKey: settings.deepseekApiKey,
          aiTone: settings.aiTone,
          aiNiche: settings.aiNiche,
          aiTargetAudience: settings.aiTargetAudience,
          aiBrandVoice: settings.aiBrandVoice,
          autoPublishEnabled: settings.autoPublishEnabled,
          autoPublishNextAt: settings.autoPublishNextAt,
          autoPublishCount: settings.autoPublishCount,
        },
      })
      .from(aiSessions)
      .leftJoin(settings, eq(settings.userId, aiSessions.userId))
      .where(and(eq(aiSessions.id, args.sessionId), eq(aiSessions.userId, userId)))
      .limit(1);
    if (!found) throw notFound("Session not found");
    const userSettings: ChatSettings = found.settings;

    const deepseekKey = await resolveDeepseekKey(db, userSettings?.deepseekApiKey);
    if (!deepseekKey) return { error: "no_api_key" };

    // Atomic metering: check + increment in one statement.
    let usage: { used: number; limit: number };
    try {
      // user.plan is fresh (read on every request): no extra `users` read.
      usage = await consumeQuota(db, userId, "aiMessagesUsed", user.plan);
    } catch (e) {
      if (isPlanLimit(e)) return { error: "plan_limit" };
      throw e;
    }

    try {
      // History BEFORE this turn (oldest first), then persist the user message.
      const prior = (
        await db
          .select({ role: aiMessages.role, content: aiMessages.content })
          .from(aiMessages)
          .where(and(eq(aiMessages.sessionId, found.id), eq(aiMessages.userId, userId)))
          .orderBy(desc(aiMessages.createdAt))
          .limit(HISTORY_LIMIT)
      ).reverse();
      await db.insert(aiMessages).values({ userId, sessionId: found.id, role: "user", content: args.message });

      const systemPrompt = await buildSystemPrompt(db, userId, usage, userSettings);

      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${deepseekKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "system", content: systemPrompt }, ...prior, { role: "user", content: args.message }],
          temperature: 0.7,
          max_tokens: 1000,
        }),
        signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
        redirect: "error",
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        console.error("[aiAssistant] DeepSeek error", res.status, safeMessage(errText, 200));
        throw new RpcError("INTERNAL", `DeepSeek API error: ${res.status}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const responseText = data.choices?.[0]?.message?.content;
      if (!responseText) throw new RpcError("INTERNAL", "DeepSeek returned no response content");

      await db.insert(aiMessages).values({ userId, sessionId: found.id, role: "assistant", content: responseText });
      await db.update(aiSessions).set({ lastMessageAt: new Date() }).where(eq(aiSessions.id, found.id));
      return { response: responseText };
    } catch (e) {
      // The assistant never answered: give the metered message back.
      await refundQuota(db, userId, "aiMessagesUsed").catch(() => {});
      if (e instanceof RpcError) throw e;
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new RpcError("INTERNAL", "The AI assistant took too long to respond. Try again.");
      console.error("[aiAssistant] failed:", safeMessage(e, 200));
      throw new RpcError("INTERNAL", "The AI assistant could not answer right now. Try again.");
    }
  },
});

async function buildSystemPrompt(db: DbLike, userId: string, usage: { used: number; limit: number }, s: ChatSettings): Promise<string> {
  const [counts, recent, analyticsRows] = await Promise.all([
    db.select({ status: videos.status, n: sql<number>`count(*)::int` }).from(videos).where(eq(videos.userId, userId)).groupBy(videos.status),
    db
      .select({ title: videos.title, tags: videos.tags, status: videos.status })
      .from(videos)
      .where(eq(videos.userId, userId))
      .orderBy(desc(videos.createdAt))
      .limit(10),
    db
      .select({ youtubeVideoId: videoAnalytics.youtubeVideoId, views: videoAnalytics.views, ctr: videoAnalytics.ctr })
      .from(videoAnalytics)
      .where(eq(videoAnalytics.userId, userId))
      .orderBy(desc(videoAnalytics.fetchedAt))
      .limit(20)
      .catch(() => []),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const c of counts) statusCounts[c.status] = c.n;

  let analytics: Record<string, unknown> | null = null;
  if (analyticsRows.length > 0) {
    const totalViews = analyticsRows.reduce((sum, r) => sum + (r.views ?? 0), 0);
    const avgCtr = analyticsRows.reduce((sum, r) => sum + (r.ctr ?? 0), 0) / analyticsRows.length;
    analytics = {
      totalViewsRecent: totalViews,
      avgCtr: Math.round(avgCtr * 1000) / 1000,
      topPerformers: [...analyticsRows]
        .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
        .slice(0, 3)
        .map((r) => ({ youtubeVideoId: r.youtubeVideoId, views: r.views, ctr: r.ctr })),
      videosWithData: analyticsRows.length,
    };
  }

  // Current time in EAT (UTC+3)
  const currentTime = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace("T", " ").substring(0, 19);

  const contextData = JSON.stringify({
    videoStatusCounts: statusCounts,
    recentVideos: recent.map((v) => ({ title: v.title, tags: v.tags ?? [], status: v.status })),
    analytics,
    settings: {
      aiTone: s?.aiTone,
      aiNiche: s?.aiNiche,
      aiTargetAudience: s?.aiTargetAudience,
      aiBrandVoice: s?.aiBrandVoice,
      autoPublishEnabled: s?.autoPublishEnabled,
      autoPublishNextAt: s?.autoPublishNextAt ? s.autoPublishNextAt.getTime() : undefined,
      autoPublishCount: s?.autoPublishCount,
    },
  });

  const remaining = usage.limit - usage.used;
  const warningNote =
    usage.used / usage.limit >= 0.8
      ? `\n\n[SYSTEM: After your response, add a single line: "Note: ${remaining} AI message${remaining === 1 ? "" : "s"} remaining this month."]`
      : "";

  return (
    `You are an AI assistant for Reelcast, a YouTube publishing platform. ` +
    `You help the user manage their video library, publishing schedule, and content strategy. ` +
    `You have access to the user's data: ${contextData}. ` +
    `Current time: ${currentTime} EAT (UTC+3, Kampala). ` +
    `IMPORTANT FORMATTING RULES: ` +
    `Never use emojis. Do not include any emoji characters anywhere in your responses. ` +
    `Use markdown for formatting: **bold**, *italic*, bullet lists with -, numbered lists, ` +
    `tables with | syntax, code blocks with \`\`\`, and headings with ## when appropriate. ` +
    `Keep responses concise and actionable.` +
    warningNote
  );
}
