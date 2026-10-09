// Replaces convex/paypal.ts + convex/actions/paypal.ts (PayPal -> Pesapal). Export ONLY rpc definitions.
// Every function is scoped to ctx.userId; the browser never sees tracking ids, confirmation codes,
// provider URLs or raw payment_* / subscription rows (see src/server/billing/status.ts).
import { z } from "zod";
import { PLANS } from "@/db/schema";
import { cancelAtPeriodEnd, changePlan as changePlanCore, checkoutForUser, resumeSubscription } from "@/server/billing/core";
import { getCurrency, getPlanPrices } from "@/server/billing/plans";
import { getBillingDeps } from "@/server/billing/service";
import { buildBillingStatus, listPaymentDtos } from "@/server/billing/status";
import { BillingConfigError } from "@/server/billing/types";
import { badRequest } from "../rpc/errors";
import { action, mutation, query } from "../rpc/define";

async function depsFor(ctx: { db: Parameters<typeof getBillingDeps>[0]; req: Request }) {
  try {
    return await getBillingDeps(ctx.db, ctx.req);
  } catch (e) {
    if (e instanceof BillingConfigError) throw badRequest(e.message);
    throw e;
  }
}

/** Plan, subscription state, renewal date/grace, scheduled change, recent payments, prices and usage. */
export const getStatus = query({
  handler: async (ctx) => buildBillingStatus(ctx.db, ctx.userId, { prices: getPlanPrices(), currency: getCurrency() }),
});

export const listPayments = query({
  input: z.object({ limit: z.number().int().min(1).max(100).optional() }),
  handler: async (ctx, args) => listPaymentDtos(ctx.db, ctx.userId, args.limit ?? 50),
});

/** Open a hosted Pesapal checkout: first purchase, or the renewal of the current plan. */
export const createCheckout = action({
  input: z.object({ plan: z.enum(["pro", "elite"]) }),
  handler: async (ctx, args) => {
    const deps = await depsFor(ctx);
    const { redirectUrl } = await checkoutForUser(ctx.db, { userId: ctx.userId, plan: args.plan }, deps);
    return { redirectUrl };
  },
});

/** Upgrade (prorated payment now), downgrade (applies at the next renewal) or "free" (= cancel at period end). */
export const changePlan = action({
  input: z.object({ plan: z.enum(PLANS) }),
  handler: async (ctx, args) => {
    const deps = await depsFor(ctx);
    const r = await changePlanCore(ctx.db, { userId: ctx.userId, plan: args.plan }, deps);
    // One uniform shape (null fields are dropped on the wire) so the UI can read every key.
    return {
      outcome: r.outcome,
      redirectUrl: r.outcome === "checkout" ? r.redirectUrl : null,
      plan: r.outcome === "scheduled" ? r.plan : null,
      effectiveAt: r.outcome === "scheduled" ? r.effectiveAt : null,
    };
  },
});

/** Stop renewing. Access continues until the paid period ends. */
export const cancel = mutation({
  handler: async (ctx) => cancelAtPeriodEnd(ctx.db, ctx.userId),
});

/** Undo a cancellation while the paid period (or grace) is still running. */
export const resume = mutation({
  handler: async (ctx) => {
    await resumeSubscription(ctx.db, ctx.userId);
  },
});
