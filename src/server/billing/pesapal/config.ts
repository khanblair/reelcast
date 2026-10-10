/**
 * Pesapal credentials: the platform_settings singleton (encrypted columns) with an env fallback
 * (PESAPAL_CONSUMER_KEY / PESAPAL_CONSUMER_SECRET) when the DB row has no complete pair.
 * Server-only; plaintext secrets never leave this process.
 */
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { platformSettings } from "@/db/schema";
import { decryptSecret } from "@/server/crypto";
import type { PesapalEnvironment } from "./client";

export type PesapalConfig = {
  consumerKey: string;
  consumerSecret: string;
  environment: PesapalEnvironment;
  /** Registered IPN id (notification_id) or null when no IPN has been registered yet. */
  ipnId: string | null;
  ipnUrl: string | null;
  source: "database" | "environment";
};

function tryDecrypt(blob: string | null | undefined, label: string): string | null {
  if (!blob) return null;
  try {
    return decryptSecret(blob).trim() || null;
  } catch {
    // Wrong APP_ENCRYPTION_KEY / corrupt value: behave as "not configured"; never log the blob.
    console.error(`[billing] stored Pesapal ${label} could not be decrypted`);
    return null;
  }
}

/**
 * The config a platform_settings row (or its absence) yields: the decrypted database pair, else the environment pair, else
 * null. Pure apart from reading process.env; a caller that already holds the row (the admin status card) uses this instead
 * of fetching it a second time.
 */
export function pesapalConfigFromRow(row: typeof platformSettings.$inferSelect | undefined): PesapalConfig | null {
  const environment: PesapalEnvironment = row?.pesapalEnvironment === "live" ? "live" : "sandbox";
  const dbKey = tryDecrypt(row?.pesapalConsumerKey, "consumer key");
  const dbSecret = tryDecrypt(row?.pesapalConsumerSecret, "consumer secret");
  if (dbKey && dbSecret) {
    return { consumerKey: dbKey, consumerSecret: dbSecret, environment, ipnId: row?.pesapalIpnId ?? null, ipnUrl: row?.pesapalIpnUrl ?? null, source: "database" };
  }
  const envKey = process.env.PESAPAL_CONSUMER_KEY?.trim();
  const envSecret = process.env.PESAPAL_CONSUMER_SECRET?.trim();
  if (envKey && envSecret) {
    return { consumerKey: envKey, consumerSecret: envSecret, environment, ipnId: row?.pesapalIpnId ?? null, ipnUrl: row?.pesapalIpnUrl ?? null, source: "environment" };
  }
  return null;
}

export async function getPesapalConfig(db: DbLike): Promise<PesapalConfig | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1)).limit(1);
  return pesapalConfigFromRow(row);
}
