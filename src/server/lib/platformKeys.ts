/**
 * Platform-level AI provider keys (admin-managed, stored encrypted in platform_settings).
 * Server-only: the plaintext must never be returned from an rpc handler.
 *
 * Mirrors Convex `platformSettings.geminiApiKey ?? process.env.GEMINI_API_KEY`.
 */
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { platformSettings } from "@/db/schema";
import { decryptSecret } from "@/server/crypto";

export type PlatformKeyName = "deepseek" | "gemini";

export async function getPlatformKey(db: DbLike, name: PlatformKeyName): Promise<string | null> {
  const [row] = await db
    .select({ deepseekApiKey: platformSettings.deepseekApiKey, geminiApiKey: platformSettings.geminiApiKey })
    .from(platformSettings)
    .where(eq(platformSettings.id, 1))
    .limit(1);

  const stored = name === "deepseek" ? row?.deepseekApiKey : row?.geminiApiKey;
  let key: string | null = null;
  if (stored) {
    try {
      key = decryptSecret(stored) || null;
    } catch {
      // Unreadable (wrong APP_ENCRYPTION_KEY / corrupt): behave as "not configured", never leak the blob.
      console.error(`[platformKeys] stored ${name} key could not be decrypted`);
    }
  }
  if (!key && name === "gemini") key = process.env.GEMINI_API_KEY?.trim() || null;
  return key;
}
