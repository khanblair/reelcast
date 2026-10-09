// Port of convex/admin/platformSettings.ts (PayPal fields replaced by Pesapal). Admin only.
// The browser gets booleans and masked hints, NEVER a key, a secret or a ciphertext.
import { eq } from "drizzle-orm";
import { z } from "zod";
import { platformSettings } from "@/db/schema";
import { createPesapalClient, PesapalError } from "@/server/billing/pesapal/client";
import { getPesapalConfig } from "@/server/billing/pesapal/config";
import { getCurrency } from "@/server/billing/plans";
import { appUrlFrom, ipnUrl, saveIpn } from "@/server/billing/service";
import { decryptSecret, encryptSecret, maskSecret } from "@/server/crypto";
import { badRequest } from "../../rpc/errors";
import { action, mutation, query } from "../../rpc/define";

/** Decrypted only to build a hint; failures read as "no hint". */
function hintOf(blob: string | null | undefined): string | null {
  if (!blob) return null;
  try {
    return maskSecret(decryptSecret(blob));
  } catch {
    return null;
  }
}

export const getStatus = query({
  auth: "admin",
  handler: async (ctx) => {
    const [row] = await ctx.db.select().from(platformSettings).where(eq(platformSettings.id, 1)).limit(1);
    const cfg = await getPesapalConfig(ctx.db);
    return {
      deepseekKeySet: !!row?.deepseekApiKey,
      geminiKeySet: !!row?.geminiApiKey,
      pesapalConfigured: !!cfg,
      pesapalConfigSource: cfg?.source ?? null,
      pesapalConsumerKeyHint: hintOf(row?.pesapalConsumerKey),
      pesapalConsumerSecretSet: !!row?.pesapalConsumerSecret || !!process.env.PESAPAL_CONSUMER_SECRET,
      pesapalEnvironment: row?.pesapalEnvironment ?? "sandbox",
      pesapalIpnRegistered: !!row?.pesapalIpnId,
      pesapalIpnUrl: row?.pesapalIpnUrl ?? null,
      pesapalCurrency: getCurrency(),
      appUrlConfigured: !!process.env.NEXT_PUBLIC_APP_URL,
    };
  },
});

const secret = z.string().trim().max(500);

/** Upserts the singleton row. Empty string clears a value. Secrets are encrypted before storage. */
export const update = mutation({
  auth: "admin",
  input: z.object({
    deepseekApiKey: secret.optional(),
    geminiApiKey: secret.optional(),
    pesapalConsumerKey: secret.optional(),
    pesapalConsumerSecret: secret.optional(),
    pesapalEnvironment: z.enum(["sandbox", "live"]).optional(),
  }),
  handler: async (ctx, args) => {
    const enc = (v: string) => (v === "" ? null : encryptSecret(v));
    const patch: Partial<typeof platformSettings.$inferInsert> = {};
    if (args.deepseekApiKey !== undefined) patch.deepseekApiKey = enc(args.deepseekApiKey);
    if (args.geminiApiKey !== undefined) patch.geminiApiKey = enc(args.geminiApiKey);
    if (args.pesapalConsumerKey !== undefined) patch.pesapalConsumerKey = enc(args.pesapalConsumerKey);
    if (args.pesapalConsumerSecret !== undefined) patch.pesapalConsumerSecret = enc(args.pesapalConsumerSecret);
    if (args.pesapalEnvironment !== undefined) patch.pesapalEnvironment = args.pesapalEnvironment;

    const [existing] = await ctx.db.select().from(platformSettings).where(eq(platformSettings.id, 1)).limit(1);
    // An IPN id belongs to one Pesapal environment AND one merchant account: it is meaningless after either changes.
    const envChanged = args.pesapalEnvironment !== undefined && args.pesapalEnvironment !== (existing?.pesapalEnvironment ?? "sandbox");
    const keyChanged = args.pesapalConsumerKey !== undefined;
    if (envChanged || keyChanged) {
      patch.pesapalIpnId = null;
      patch.pesapalIpnUrl = null;
    }
    if (Object.keys(patch).length === 0) return;
    await ctx.db
      .insert(platformSettings)
      .values({ id: 1, ...patch })
      .onConflictDoUpdate({ target: platformSettings.id, set: { ...patch, updatedAt: new Date() } });
  },
});

/** Registers our IPN URL with Pesapal (reusing an identical existing registration) and stores the ipn_id. */
export const registerIpn = action({
  auth: "admin",
  handler: async (ctx) => {
    const cfg = await getPesapalConfig(ctx.db);
    if (!cfg) throw badRequest("Save the Pesapal consumer key and secret first.");
    const url = ipnUrl();
    if (!url) throw badRequest("Set NEXT_PUBLIC_APP_URL to your public https URL first.");
    const host = new URL(url).hostname;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|0\.0\.0\.0$)/.test(host) || host === "[::1]") {
      throw badRequest("Pesapal can't reach a local address. Set NEXT_PUBLIC_APP_URL to your public https URL.");
    }
    const client = createPesapalClient({ consumerKey: cfg.consumerKey, consumerSecret: cfg.consumerSecret, environment: cfg.environment });
    try {
      const existing = (await client.getIpnList()).find((i) => i.url === url);
      const registered = existing ?? (await client.registerIpn(url, "GET"));
      await saveIpn(ctx.db, registered.ipnId, url);
      return { ipnUrl: url, reused: !!existing, environment: cfg.environment };
    } catch (e) {
      if (e instanceof PesapalError) throw badRequest(`Pesapal: ${e.message}`);
      throw e;
    }
  },
});

// Exposed so the admin card can show the callback URL the owner may need to whitelist.
export const getUrls = query({
  auth: "admin",
  handler: async (ctx) => {
    const base = appUrlFrom(ctx.req);
    return { ipnUrl: `${base}/api/webhooks/pesapal/ipn`, callbackUrl: `${base}/api/billing/callback` };
  },
});
