/**
 * Billing page: what to refetch while waiting for a payment to clear.
 *
 * Everything on the billing page comes from the single `billing.getStatus` query (plan, subscription,
 * usage meters, payment history; its child components make no queries of their own). So the 4 s poll
 * only needs that one query. Other views (sidebar plan badge, limits elsewhere) read the plan from
 * other queries, so when the payment lands we refresh everything once.
 *
 * Pure module: no React, so it is unit-testable.
 */

/** Matches ["rpc", "billing.getStatus", <args>] and nothing else (TanStack matches by array prefix). */
export const BILLING_STATUS_KEY = ["rpc", "billing.getStatus"] as const;

/** Every rpc query. */
export const ALL_RPC_KEY = ["rpc"] as const;

type StatusLike =
  | {
      plan?: string | null;
      subscription?: { status?: string | null; plan?: string | null; periodEnd?: unknown } | null;
    }
  | null
  | undefined;

/**
 * Fingerprint of the parts of billing.getStatus that a cleared payment changes: the user's plan and the
 * subscription's status, plan and period end. undefined until the status has loaded.
 */
export function billingSignature(status: StatusLike): string | undefined {
  if (!status) return undefined;
  const sub = status.subscription;
  return [status.plan ?? "", sub?.status ?? "", sub?.plan ?? "", sub ? String(sub.periodEnd ?? "") : ""].join("|");
}

export type PaymentWatch = {
  /** Signature seen when waiting began. */
  baseline: string | undefined;
  /** The one full refresh has been requested already. */
  refreshed: boolean;
};

export const INITIAL_PAYMENT_WATCH: PaymentWatch = { baseline: undefined, refreshed: false };

/**
 * Feed it every render's signature. `refreshAll` is true exactly once: the first time the signature
 * differs from the one captured while the page was waiting for the payment. The refetch that follows
 * returns the same signature, so this cannot loop.
 */
export function stepPaymentWatch(
  watch: PaymentWatch,
  input: { signature: string | undefined; waiting: boolean },
): { watch: PaymentWatch; refreshAll: boolean } {
  const { signature, waiting } = input;
  if (signature === undefined) return { watch, refreshAll: false };

  // The baseline is the first status we see while waiting; the status of a page that never waited
  // (or that loaded already paid) is not a baseline, so it can never "flip".
  const baseline = watch.baseline ?? (waiting ? signature : undefined);
  if (baseline === undefined) return { watch, refreshAll: false };

  if (!watch.refreshed && signature !== baseline) {
    return { watch: { baseline, refreshed: true }, refreshAll: true };
  }
  return { watch: baseline === watch.baseline ? watch : { baseline, refreshed: watch.refreshed }, refreshAll: false };
}
