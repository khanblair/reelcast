import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ALL_RPC_KEY, BILLING_STATUS_KEY, INITIAL_PAYMENT_WATCH, billingSignature, stepPaymentWatch, type PaymentWatch } from "./billing-poll";
import { api } from "./rpc/client";

describe("polling keys", () => {
  test("the narrow key is the billing.getStatus query's path", () => {
    expect<string[]>([...BILLING_STATUS_KEY]).toEqual(["rpc", api.billing.getStatus.__path]);
    expect<string[]>([...ALL_RPC_KEY]).toEqual(["rpc"]);
  });

  test("it invalidates billing.getStatus (any args) and nothing else", () => {
    const qc = new QueryClient();
    const keys = [
      ["rpc", "billing.getStatus", {}],
      ["rpc", "billing.getStatus", null],
      ["rpc", "billing.getStatusX", {}],
      ["rpc", "billing.listPayments", {}],
      ["rpc", "videos.list", {}],
    ];
    for (const k of keys) qc.setQueryData(k, 1);
    void qc.invalidateQueries({ queryKey: BILLING_STATUS_KEY });
    expect(keys.map((k) => qc.getQueryState(k)?.isInvalidated)).toEqual([true, true, false, false, false]);
  });
});

const free = { plan: "free", subscription: null };
const pending = { plan: "free", subscription: { status: "approval_pending", plan: "pro", periodEnd: null } };
const active = { plan: "pro", subscription: { status: "active", plan: "pro", periodEnd: 1_800_000_000_000 } };

describe("billingSignature", () => {
  test("undefined until loaded, stable for equal data, different once the payment clears", () => {
    expect(billingSignature(undefined)).toBeUndefined();
    expect(billingSignature(null)).toBeUndefined();
    expect(billingSignature(pending)).toBe(billingSignature({ ...pending }));
    expect(billingSignature(pending)).not.toBe(billingSignature(active));
    expect(billingSignature(free)).not.toBe(billingSignature(pending));
  });

  test("a renewal moves the period end", () => {
    const renewed = { ...active, subscription: { ...active.subscription, periodEnd: 1_802_592_000_000 } };
    expect(billingSignature(renewed)).not.toBe(billingSignature(active));
  });
});

/** Run a sequence of renders through the pure step and report when the one full refresh fired. */
function run(renders: { status: Parameters<typeof billingSignature>[0]; waiting: boolean }[]) {
  let watch: PaymentWatch = INITIAL_PAYMENT_WATCH;
  return renders.map(({ status, waiting }) => {
    const step = stepPaymentWatch(watch, { signature: billingSignature(status), waiting });
    watch = step.watch;
    return step.refreshAll;
  });
}

describe("stepPaymentWatch", () => {
  test("?status=success: waits on a pending subscription, refreshes everything once when it goes active", () => {
    expect(
      run([
        { status: undefined, waiting: true }, // still loading
        { status: pending, waiting: true },
        { status: pending, waiting: true }, // 4 s polls: same data
        { status: pending, waiting: true },
        { status: active, waiting: false }, // payment cleared; waitingForPayment drops in the same render
        { status: active, waiting: false }, // the refetch that follows
      ]),
    ).toEqual([false, false, false, false, true, false]);
  });

  test("?status=pending keeps waiting after the flip, still refreshes only once", () => {
    expect(
      run([
        { status: free, waiting: true },
        { status: free, waiting: true },
        { status: active, waiting: true },
        { status: active, waiting: true },
        { status: active, waiting: true },
      ]),
    ).toEqual([false, false, true, false, false]);
  });

  test("an upgrade from an active plan is detected through the plan change", () => {
    const upgraded = { plan: "business", subscription: { status: "active", plan: "business", periodEnd: 1_802_592_000_000 } };
    expect(
      run([
        { status: active, waiting: true },
        { status: active, waiting: true },
        { status: upgraded, waiting: true },
      ]),
    ).toEqual([false, false, true]);
  });

  test("a page that never waited, or that loaded already paid, never refreshes everything", () => {
    expect(
      run([
        { status: free, waiting: false },
        { status: active, waiting: false }, // e.g. the LIVE 10 s poll or the user's own write; writes invalidate themselves
        { status: active, waiting: false },
      ]),
    ).toEqual([false, false, false]);
    expect(run([{ status: active, waiting: false }])).toEqual([false]);
  });

  test("status cached before waiting began is not used as a baseline", () => {
    // first render: returnState not applied yet (waiting=false) with a cached status; then waiting starts
    expect(
      run([
        { status: pending, waiting: false },
        { status: pending, waiting: true },
        { status: active, waiting: false },
      ]),
    ).toEqual([false, false, true]);
  });

  test("re-running the same input (StrictMode double effects) does not fire twice", () => {
    let watch = INITIAL_PAYMENT_WATCH;
    const feed = (status: Parameters<typeof billingSignature>[0], waiting: boolean) => {
      const step = stepPaymentWatch(watch, { signature: billingSignature(status), waiting });
      watch = step.watch;
      return step.refreshAll;
    };
    feed(pending, true);
    expect([feed(active, false), feed(active, false), feed(active, false)]).toEqual([true, false, false]);
  });
});
