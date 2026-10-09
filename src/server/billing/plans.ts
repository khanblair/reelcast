/**
 * Plan catalogue, prices and period math (server side).
 *
 * Prices are expressed in PESAPAL_CURRENCY (default USD):
 *   PLAN_PRO_PRICE    falls back to NEXT_PUBLIC_PRO_PRICE_USD (the old PayPal-era variable), then 19.
 *   PLAN_ELITE_PRICE  has NO default. The old UI sold Elite as "Invite only" (assigned by an admin),
 *                     so Elite is only purchasable once the owner sets this variable.
 * Money is handled in integer cents everywhere it is compared or prorated.
 */
import { GRACE_DAYS, PERIOD_DAYS, PLAN_NAMES, PLAN_RANK, RENEWAL_LEAD_DAYS, type PlanKey } from "@/components/billing/plans";

export { GRACE_DAYS, PERIOD_DAYS, PLAN_NAMES, PLAN_RANK, RENEWAL_LEAD_DAYS };
export type { PlanKey };

export type PaidPlan = "pro" | "elite";
export type PlanPrices = Record<PaidPlan, number | null>;

export const DAY_MS = 86_400_000;
export const PERIOD_MS = PERIOD_DAYS * DAY_MS;
export const GRACE_MS = GRACE_DAYS * DAY_MS;
export const RENEWAL_LEAD_MS = RENEWAL_LEAD_DAYS * DAY_MS;

/** An upgrade whose prorated difference is below this is scheduled for the next renewal instead of charged now. */
export const MIN_UPGRADE_CHARGE_CENTS = 100;

export const isPaidPlan = (p: unknown): p is PaidPlan => p === "pro" || p === "elite";

export function toCents(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}

/** numeric(12,2) text for the DB / Pesapal. */
export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parsePrice(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/** Charge currency (ISO 4217, upper-case). Invalid values fall back to USD. */
export function getCurrency(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PESAPAL_CURRENCY ?? "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : "USD";
}

export function getPlanPrices(env: NodeJS.ProcessEnv = process.env): PlanPrices {
  return {
    pro: parsePrice(env.PLAN_PRO_PRICE) ?? parsePrice(env.NEXT_PUBLIC_PRO_PRICE_USD) ?? 19,
    elite: parsePrice(env.PLAN_ELITE_PRICE),
  };
}

export function addPeriod(base: Date): Date {
  return new Date(base.getTime() + PERIOD_MS);
}

/**
 * Prorated charge (cents) for moving from `oldPrice` to `newPrice` with `periodEnd` still ahead.
 * Rounded UP to the next cent so we never under-collect. 0 when it is not an upgrade or the period is over.
 */
export function prorateUpgradeCents(input: { oldPrice: number; newPrice: number; periodEnd: Date; now: Date }): number {
  const diffCents = toCents(input.newPrice) - toCents(input.oldPrice);
  if (diffCents <= 0) return 0;
  const remainingMs = Math.min(Math.max(input.periodEnd.getTime() - input.now.getTime(), 0), PERIOD_MS);
  return Math.ceil((diffCents * remainingMs) / PERIOD_MS);
}

export const planRank = (plan: string | null | undefined): number => PLAN_RANK[(plan as PlanKey) in PLAN_RANK ? (plan as PlanKey) : "free"];
