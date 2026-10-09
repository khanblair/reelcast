/**
 * Provider-agnostic billing contracts. `core.ts` only ever talks to a `PaymentProvider`, so it is
 * unit-testable with a fake and the Pesapal specifics live in ./pesapal/*.
 */

/** A payment status obtained from the PROVIDER's own API (never from a callback / IPN query string). */
export type VerifiedStatus = {
  orderTrackingId: string;
  /** Echo of the merchant reference we submitted; the binding check against the stored order. */
  merchantReference: string | null;
  /** 0 invalid/pending, 1 completed, 2 failed, 3 reversed. */
  statusCode: 0 | 1 | 2 | 3;
  statusDescription: string | null;
  amount: number | null;
  currency: string | null;
  confirmationCode: string | null;
  paymentMethod: string | null;
};

export type ProviderSubmitInput = {
  merchantRef: string;
  /** Cents-accurate decimal amount, e.g. 19 or 12.35. */
  amount: number;
  currency: string;
  description: string;
  callbackUrl: string;
  cancellationUrl: string;
  buyer: { email: string; firstName?: string; lastName?: string };
};

export type ProviderSubmitResult = { orderTrackingId: string; redirectUrl: string };

export interface PaymentProvider {
  readonly name: "pesapal";
  /** Create a hosted checkout. Called at most once per merchant reference. */
  submitOrder(input: ProviderSubmitInput): Promise<ProviderSubmitResult>;
  /** The authoritative payment status for an order tracking id. */
  getStatus(orderTrackingId: string): Promise<VerifiedStatus>;
  /** Best effort: stop a pending hosted checkout from being paid. */
  cancelOrder(orderTrackingId: string): Promise<void>;
}

/** Payments are not set up (no credentials / IPN id). The message is safe to show to the user. */
export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingConfigError";
  }
}
