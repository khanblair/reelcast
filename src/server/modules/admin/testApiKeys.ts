// Port of convex/admin/testApiKeys.ts. The Convex version called requireAdmin with an action ctx that has
// no `.db`, so it always threw; here the admin check is the rpc `auth: "admin"` gate (read from the DB).
// Real minimal calls, hard timeouts, and nothing from the provider (or the key) is echoed back.
import { getPlatformKey } from "@/server/lib/platformKeys";
import { GEMINI_MODEL } from "@/server/lib/ai/metadata";
import { action } from "../../rpc/define";

type TestResult = { success: boolean; message: string };

const TIMEOUT_MS = 15_000;
const PROMPT = "Reply with the single word OK.";

function failure(provider: string, e: unknown): TestResult {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return { success: false, message: `${provider} did not answer within ${TIMEOUT_MS / 1000}s.` };
  return { success: false, message: `Could not reach ${provider}.` };
}

function httpFailure(provider: string, status: number): TestResult {
  const hint = status === 401 || status === 403 ? "the key was rejected" : status === 429 ? "rate limited or out of quota" : "the service returned an error";
  return { success: false, message: `${provider} returned HTTP ${status}: ${hint}.` };
}

export const testDeepseek = action({
  auth: "admin",
  handler: async (ctx): Promise<TestResult> => {
    const key = await getPlatformKey(ctx.db, "deepseek");
    if (!key) return { success: false, message: "No DeepSeek key configured." };
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: PROMPT }], max_tokens: 5 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return httpFailure("DeepSeek", res.status);
      const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
      const reply = data?.choices?.[0]?.message?.content;
      return { success: true, message: `DeepSeek replied: "${typeof reply === "string" ? reply.trim().slice(0, 60) : "(no content)"}"` };
    } catch (e) {
      return failure("DeepSeek", e);
    }
  },
});

export const testGemini = action({
  auth: "admin",
  handler: async (ctx): Promise<TestResult> => {
    const key = await getPlatformKey(ctx.db, "gemini");
    if (!key) return { success: false, message: "No Gemini key configured." };
    try {
      // Key goes in a header, not the URL, so it can't leak into logs.
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: PROMPT }] }],
          generationConfig: { maxOutputTokens: 16, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return httpFailure("Gemini", res.status);
      const data = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] } | null;
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      return { success: true, message: `Gemini replied: "${typeof reply === "string" ? reply.trim().slice(0, 60) : "(no content)"}"` };
    } catch (e) {
      return failure("Gemini", e);
    }
  },
});
