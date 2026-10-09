/**
 * Small shared helpers for the AI / generation runtime.
 */
import { PermanentAiError } from "@/server/lib/ai";
import { RpcError } from "@/server/rpc/errors";

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Remove anything that looks like an API key / bearer token before text is stored or shown. */
export function redact(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/\bsk-[0-9A-Za-z_-]{16,}/g, "[redacted]")
    .replace(/\bre_[0-9A-Za-z_-]{16,}/g, "[redacted]")
    .replace(/Bearer\s+[0-9A-Za-z._-]{12,}/gi, "Bearer [redacted]")
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, "$1[redacted]");
}

/** Message that is safe to persist on a row and show to the owner (redacted, single paragraph, bounded). */
export function safeMessage(e: unknown, max = 300): string {
  return redact(errMsg(e)).replace(/\s+/g, " ").trim().slice(0, max);
}

/** An error the browser may see (an unknown plain Error would become "Internal error"). */
export function publicError(prefix: string, e: unknown): RpcError {
  return new RpcError("INTERNAL", `${prefix}: ${safeMessage(e, 200)}`);
}

export const isPlanLimitError = (e: unknown): boolean => e instanceof RpcError && e.code === "PLAN_LIMIT_EXCEEDED";

export const GEMINI_NOT_CONFIGURED = "Gemini API key not configured. Set it in Admin > Settings or GEMINI_API_KEY env var.";
export const METADATA_LIMIT_MESSAGE = "Metadata generation limit reached for your plan. Upgrade to regenerate more videos.";

/** Thrown when no Gemini key is configured anywhere (permanent until an admin sets one). */
export class GeminiNotConfiguredError extends PermanentAiError {
  constructor() {
    super(GEMINI_NOT_CONFIGURED);
    this.name = "GeminiNotConfiguredError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
