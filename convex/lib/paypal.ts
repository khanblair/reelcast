"use node";

// Thin client for PayPal REST API v1/v2 (Subscriptions + Catalog Products).
// Docs: https://developer.paypal.com/docs/subscriptions/
//
// Auth: OAuth2 client-credentials grant. Access tokens are short-lived
// (~9 hours) but we don't bother caching across Convex action invocations —
// each action call fetches its own token, keeping things simple and
// avoiding any cross-invocation cache-staleness bugs.

export type PayPalEnvironment = "sandbox" | "live";

const BASE_URLS: Record<PayPalEnvironment, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

function baseUrl(env: PayPalEnvironment): string {
  return BASE_URLS[env];
}

async function paypalFetch<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`PayPal returned a non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const b = body as { message?: string; error_description?: string; details?: Array<{ description?: string }> };
    const message = b?.message
      ?? b?.error_description
      ?? b?.details?.[0]?.description
      ?? `HTTP ${res.status}`;
    throw new Error(`PayPal API error: ${message}`);
  }
  return body as T;
}

export interface PayPalAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function getAccessToken(
  env: PayPalEnvironment,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const data = await paypalFetch<PayPalAuthResponse>(`${baseUrl(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!data.access_token) throw new Error("PayPal auth did not return an access token.");
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Catalog Products — a subscription plan must belong to a "product"
// ---------------------------------------------------------------------------

export interface CreateProductResponse {
  id: string;
  name: string;
}

export async function createProduct(
  env: PayPalEnvironment,
  token: string,
  name: string,
  description: string,
): Promise<CreateProductResponse> {
  return paypalFetch<CreateProductResponse>(`${baseUrl(env)}/v1/catalogs/products`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, type: "SERVICE", category: "SOFTWARE" }),
  });
}

// ---------------------------------------------------------------------------
// Billing Plans — defines price + monthly billing cycle for a product
// ---------------------------------------------------------------------------

export interface CreatePlanResponse {
  id: string;
  status: string;
}

export async function createPlan(
  env: PayPalEnvironment,
  token: string,
  productId: string,
  planName: string,
  priceUsd: number,
): Promise<CreatePlanResponse> {
  return paypalFetch<CreatePlanResponse>(`${baseUrl(env)}/v1/billing/plans`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: productId,
      name: planName,
      description: `${planName} — billed monthly`,
      status: "ACTIVE",
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0, // 0 = infinite, renews until cancelled
          pricing_scheme: {
            fixed_price: { value: priceUsd.toFixed(2), currency_code: "USD" },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: "CONTINUE",
        payment_failure_threshold: 3,
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// Subscriptions — one per customer, created at checkout time
// ---------------------------------------------------------------------------

export interface CreateSubscriptionResponse {
  id: string;
  status: string;
  links: Array<{ href: string; rel: string; method: string }>;
}

export async function createSubscription(
  env: PayPalEnvironment,
  token: string,
  planId: string,
  customId: string,
  email: string,
  returnUrl: string,
  cancelUrl: string,
): Promise<CreateSubscriptionResponse> {
  return paypalFetch<CreateSubscriptionResponse>(`${baseUrl(env)}/v1/billing/subscriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      plan_id: planId,
      custom_id: customId, // our Convex user._id — read back from webhook payloads
      subscriber: { email_address: email },
      application_context: {
        brand_name: "Reelcast",
        user_action: "SUBSCRIBE_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
  });
}

export interface GetSubscriptionResponse {
  id: string;
  status: string; // APPROVAL_PENDING | APPROVED | ACTIVE | SUSPENDED | CANCELLED | EXPIRED
  custom_id?: string;
  billing_info?: {
    next_billing_time?: string;
    last_payment?: { amount?: { value?: string; currency_code?: string }; time?: string };
  };
}

export async function getSubscription(
  env: PayPalEnvironment,
  token: string,
  subscriptionId: string,
): Promise<GetSubscriptionResponse> {
  return paypalFetch<GetSubscriptionResponse>(`${baseUrl(env)}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Webhooks — registered once via API so we don't have to click around the
// PayPal dashboard. PayPal signs every webhook delivery; verification is
// itself an API call (verify-webhook-signature) rather than local HMAC,
// since PayPal uses cert-based signing (transmission-sig / cert-url), not a
// pre-shared secret we could check with Web Crypto directly.
// ---------------------------------------------------------------------------

export interface CreateWebhookResponse {
  id: string;
}

const SUBSCRIPTION_EVENT_TYPES = [
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "PAYMENT.SALE.COMPLETED",
];

export async function createWebhook(
  env: PayPalEnvironment,
  token: string,
  url: string,
): Promise<CreateWebhookResponse> {
  return paypalFetch<CreateWebhookResponse>(`${baseUrl(env)}/v1/notifications/webhooks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      event_types: SUBSCRIPTION_EVENT_TYPES.map((name) => ({ name })),
    }),
  });
}

export interface ListWebhooksResponse {
  webhooks: Array<{ id: string; url: string }>;
}

/**
 * Lists webhooks already registered on this PayPal app. Used by
 * registerWebhook to make registration idempotent — PayPal rejects
 * creating a second webhook for a URL that's already registered
 * ("Webhook URL already exists"), so we look up and reuse the existing
 * one instead of erroring.
 */
export async function listWebhooks(
  env: PayPalEnvironment,
  token: string,
): Promise<ListWebhooksResponse> {
  return paypalFetch<ListWebhooksResponse>(`${baseUrl(env)}/v1/notifications/webhooks`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface VerifyWebhookSignatureArgs {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  webhookEvent: unknown;
}

export interface VerifyWebhookSignatureResponse {
  verification_status: "SUCCESS" | "FAILURE";
}

export async function verifyWebhookSignature(
  env: PayPalEnvironment,
  token: string,
  args: VerifyWebhookSignatureArgs,
): Promise<boolean> {
  const data = await paypalFetch<VerifyWebhookSignatureResponse>(
    `${baseUrl(env)}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_algo: args.authAlgo,
        cert_url: args.certUrl,
        transmission_id: args.transmissionId,
        transmission_sig: args.transmissionSig,
        transmission_time: args.transmissionTime,
        webhook_id: args.webhookId,
        webhook_event: args.webhookEvent,
      }),
    },
  );
  return data.verification_status === "SUCCESS";
}

/** Extracts the "approve" link customers must be redirected to. */
export function findApproveLink(links: Array<{ href: string; rel: string }>): string | null {
  return links.find((l) => l.rel === "approve")?.href ?? null;
}
