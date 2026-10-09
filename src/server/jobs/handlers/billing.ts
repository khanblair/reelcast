/**
 * Billing sweeps (replace the Convex crons for subscription upkeep). The tick claims each sweep
 * atomically, so overlapping workers never run the same one twice.
 *   billing.renewal   every 15 min  create the renewal order (+ reminder) for periods ending within 3 days
 *   billing.expiry    every 15 min  active -> past_due (3 day grace) -> expired, downgrade respecting plan_source
 *   billing.reconcile every 5 min   poll Pesapal for unpaid orders older than 10 min so a lost IPN can't strand a payment
 */
import { purgeUnmatchedEvents, runExpirySweep, runReconcileSweep, runRenewalSweep } from "@/server/billing/core";
import { getCurrency, getPlanPrices } from "@/server/billing/plans";
import { getProvider } from "@/server/billing/service";
import type { HandlerSet } from "../handlers";

const MIN = 60_000;

export const handlers: HandlerSet = {
  sweeps: [
    {
      name: "billing.renewal",
      everyMs: 15 * MIN,
      run: async ({ db, now }) => {
        await runRenewalSweep(db, { prices: getPlanPrices(), currency: getCurrency(), now: () => now });
      },
    },
    {
      name: "billing.expiry",
      everyMs: 15 * MIN,
      run: async ({ db, now }) => {
        await runExpirySweep(db, { now });
      },
    },
    {
      name: "billing.reconcile",
      everyMs: 5 * MIN,
      run: async ({ db, now }) => {
        const provider = await getProvider(db);
        if (!provider) return; // payments not configured: nothing can be pending
        await runReconcileSweep(db, { provider, now: () => now });
        await purgeUnmatchedEvents(db, now);
      },
    },
  ],
};
