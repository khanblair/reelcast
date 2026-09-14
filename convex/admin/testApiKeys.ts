"use node";

import { action, ActionCtx, DatabaseReader } from "../_generated/server";
import { internal } from "../_generated/api";
import { getCurrentUserOrThrow } from "../lib/auth";
import { GoogleGenAI } from "@google/genai";

// NOTE: This was copy-pasted from convex/admin/platformSettings.ts's
// requireAdmin, which is only ever called from `query`/`mutation` handlers
// (where `ctx.db` exists). `ActionCtx` (used by the actions below) has no
// `.db` — actions only get `runQuery`/`runMutation` — so this call to
// `ctx.db.query(...)` already throws at runtime today. Preserving that
// existing behavior here (this task is scoped to type annotations only);
// the cast below is what makes the pre-existing shape mismatch type-check
// without resorting to `any`.
async function requireAdmin(ctx: ActionCtx) {
  const identity = await getCurrentUserOrThrow(ctx);
  const db = (ctx as unknown as { db: DatabaseReader }).db;
  const user = await db
    .query("users")
    .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
    .unique();
  if (!user?.isAdmin) throw new Error("Admin required");
}

export const testDeepseek = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; message: string }> => {
    await requireAdmin(ctx);
    const platform = await ctx.runQuery(internal.admin.platformSettings.getInternal);
    const key = platform?.deepseekApiKey;
    if (!key) return { success: false, message: "No DeepSeek key configured." };

    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "Reply with the single word OK." }],
          max_tokens: 5,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { success: false, message: `DeepSeek error ${res.status}: ${body.slice(0, 120)}` };
      }
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content ?? "(no content)";
      return { success: true, message: `DeepSeek replied: "${reply.trim()}"` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const testGemini = action({
  args: {},
  handler: async (ctx): Promise<{ success: boolean; message: string }> => {
    await requireAdmin(ctx);
    const platform = await ctx.runQuery(internal.admin.platformSettings.getInternal);
    const key = platform?.geminiApiKey ?? process.env.GEMINI_API_KEY;
    if (!key) return { success: false, message: "No Gemini key configured." };

    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const res = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: [{ role: "user", parts: [{ text: "Reply with the single word OK." }] }],
      });
      const reply = res.text ?? "(no content)";
      return { success: true, message: `Gemini replied: "${reply.trim().slice(0, 60)}"` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : String(err) };
    }
  },
});
