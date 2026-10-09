/**
 * Wiring: platform settings / env -> provider + deps for core. Everything the rpc layer, the
 * route handlers and the job sweeps share lives here so they cannot drift apart.
 */
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { platformSettings } from "@/db/schema";
import type { BillingDeps } from "./core";
import { getCurrency, getPlanPrices } from "./plans";
import { getPesapalConfig } from "./pesapal/config";
import { createPesapalProvider } from "./pesapal/provider";
import { BillingConfigError, type PaymentProvider } from "./types";

/** NEXT_PUBLIC_APP_URL without a trailing slash, or the request origin as a fallback. */
export function appUrlFrom(req?: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  if (req) return new URL(req.url).origin;
  return "";
}

/** The Pesapal provider, or null when no credentials are configured (DB or env). */
export async function getProvider(db: DbLike): Promise<PaymentProvider | null> {
  const cfg = await getPesapalConfig(db);
  return cfg ? createPesapalProvider(cfg) : null;
}

export async function requireProvider(db: DbLike): Promise<PaymentProvider> {
  const provider = await getProvider(db);
  if (!provider) throw new BillingConfigError("Payments aren't set up yet. Please contact support.");
  return provider;
}

export async function getBillingDeps(db: DbLike, req?: Request): Promise<BillingDeps> {
  const appUrl = appUrlFrom(req);
  if (!appUrl) throw new BillingConfigError("Payments aren't set up yet. Please contact support.");
  return { provider: await requireProvider(db), prices: getPlanPrices(), currency: getCurrency(), appUrl };
}

/** True when checkout can work: credentials present AND an IPN id registered. Booleans only. */
export async function paymentsReady(db: DbLike): Promise<{ configured: boolean; ipnRegistered: boolean }> {
  const cfg = await getPesapalConfig(db);
  return { configured: !!cfg, ipnRegistered: !!cfg?.ipnId };
}

/** The IPN endpoint Pesapal must be told about (derived from NEXT_PUBLIC_APP_URL). */
export function ipnUrl(): string | null {
  const base = appUrlFrom();
  return base ? `${base}/api/webhooks/pesapal/ipn` : null;
}

export async function saveIpn(db: DbLike, ipnId: string, url: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ id: 1, pesapalIpnId: ipnId, pesapalIpnUrl: url })
    .onConflictDoUpdate({ target: platformSettings.id, set: { pesapalIpnId: ipnId, pesapalIpnUrl: url, updatedAt: new Date() } });
}

export async function clearIpn(db: DbLike): Promise<void> {
  await db.update(platformSettings).set({ pesapalIpnId: null, pesapalIpnUrl: null, updatedAt: new Date() }).where(eq(platformSettings.id, 1));
}
