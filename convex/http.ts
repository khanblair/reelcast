import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const http = httpRouter();

// RSA public key exposed so Convex cloud can validate our custom RS256 JWTs.
// Must live here (convex.site) — Convex backend cannot reach localhost.
const JWK = {
  kty: "RSA",
  n: "l1ONlPsRK6m6AwxU3EBI0zmd_wQd42ehc5hkrb5XYbaAsv8yU0l_7NCwIvSXHHRnfeM8CtTjfbKehnP96sbNqCuzf9ZvzHt9EfRhR5dPTNZQ5T79Qe84AQKj-aFDHqvLer0z3GsGJ-eD0MfxjmdDeEUVaJe3m-vHTWHei6JKzwcT8L_1yhZXFyPDtziQltVhst2HHTe-1_Aqmac5ItMk3o1BVqVmOWBsyu8coysT8RaM4BNJGNGEHqr-n7ua1KwNI1GN_ZH4mnsiYlcp0tOM2lWk9NwpdzrgpjUm0cZeUBvkIcKHgcwI7X_9ek7tA7LO8yQX7qlxiUqkNOMuiwAMWw",
  e: "AQAB",
  use: "sig",
  alg: "RS256",
  kid: "reelcast-1",
};

const SITE_URL = "https://limitless-kiwi-823.convex.site";

// Convex does OIDC discovery: fetches /.well-known/openid-configuration first,
// then follows jwks_uri to get the public key.
http.route({
  path: "/.well-known/openid-configuration",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(
      JSON.stringify({
        issuer: SITE_URL,
        jwks_uri: `${SITE_URL}/.well-known/jwks.json`,
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }),
});

http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(JSON.stringify({ keys: [JWK] }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }),
});

// ---------------------------------------------------------------------------
// Lemon Squeezy billing webhook
// ---------------------------------------------------------------------------
//
// Register this URL in the Lemon Squeezy dashboard (Settings → Webhooks):
//   ${NEXT_PUBLIC_CONVEX_SITE_URL}/webhooks/lemonsqueezy
// Signing secret must match the Convex env var LEMONSQUEEZY_WEBHOOK_SECRET
// (set via `npx convex env set LEMONSQUEEZY_WEBHOOK_SECRET ...`).
//
// Verification uses Web Crypto (crypto.subtle) rather than Node's `crypto`
// module — httpAction runs in Convex's default (non-"use node") runtime,
// which has Web Crypto available, so no node runtime is needed here.

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function verifyLemonSqueezySignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader) return false;

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToBytes(signatureHeader);
  } catch {
    return false;
  }
  if (signatureBytes.length === 0) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // crypto.subtle.verify performs a constant-time comparison internally.
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes.buffer as ArrayBuffer,
    new TextEncoder().encode(rawBody).buffer as ArrayBuffer,
  );
}

function toEpochMs(iso: unknown): number | undefined {
  if (typeof iso !== "string" || !iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

const ACTIVE_STATUSES = new Set(["active", "on_trial"]);

interface LemonSqueezyWebhookPayload {
  meta?: {
    event_name?: string;
    custom_data?: { user_id?: string };
  };
  data?: {
    id?: string;
    attributes?: {
      customer_id?: number | string;
      variant_id?: number | string;
      status?: string;
      renews_at?: string;
      ends_at?: string;
      [key: string]: unknown;
    };
  };
}

http.route({
  path: "/webhooks/lemonsqueezy",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[lemonsqueezy webhook] LEMONSQUEEZY_WEBHOOK_SECRET is not configured");
      return new Response("Webhook not configured", { status: 500 });
    }

    // Read the raw body as text FIRST — required for signature verification
    // before any JSON parsing touches it.
    const rawBody = await request.text();
    const signatureHeader = request.headers.get("X-Signature") ?? request.headers.get("x-signature");

    const valid = await verifyLemonSqueezySignature(rawBody, signatureHeader, secret);
    if (!valid) {
      console.warn("[lemonsqueezy webhook] invalid signature");
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: LemonSqueezyWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as LemonSqueezyWebhookPayload;
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const eventName: string | undefined = payload?.meta?.event_name;
    const objectId: string | undefined = payload?.data?.id;
    if (!eventName || !objectId) {
      return new Response("Missing event metadata", { status: 400 });
    }

    const eventId = `${eventName}:${objectId}`;
    const customUserId: string | undefined = payload?.meta?.custom_data?.user_id;

    const attributes = payload?.data?.attributes ?? {};
    const customerId: string | undefined = attributes.customer_id != null ? String(attributes.customer_id) : undefined;
    const subscriptionId: string | undefined = objectId;
    const variantId: string | undefined = attributes.variant_id != null ? String(attributes.variant_id) : undefined;
    const status: string | undefined = attributes.status;
    const renewsAt = toEpochMs(attributes.renews_at);
    const endsAt = toEpochMs(attributes.ends_at);

    // Idempotency check — insert-if-absent. Skip processing if already seen.
    const { alreadyProcessed } = await ctx.runMutation(internal.billing.checkAndRecordEvent, {
      eventId,
      eventName,
      subscriptionId,
    });
    if (alreadyProcessed) {
      return new Response("OK (already processed)", { status: 200 });
    }

    // Resolve the Convex user: prefer the custom_data echoed back from
    // checkout, fall back to a previously-linked lemonSqueezyCustomerId.
    let userId: Id<"users"> | undefined;
    if (customUserId) {
      userId = customUserId as Id<"users">;
    } else if (customerId) {
      const byCustomer = await ctx.runQuery(internal.billing.getUserByLemonSqueezyCustomerId, { customerId });
      userId = byCustomer?._id;
    }
    if (!userId && subscriptionId) {
      const bySub = await ctx.runQuery(internal.billing.getUserByLemonSqueezySubscriptionId, { subscriptionId });
      userId = bySub?._id;
    }

    if (!userId) {
      console.warn(`[lemonsqueezy webhook] could not resolve user for event ${eventId}`);
      return new Response("OK (no matching user)", { status: 200 });
    }

    try {
      switch (eventName) {
        case "subscription_created":
        case "subscription_updated":
        case "subscription_resumed":
        case "subscription_payment_success": {
          if (status && ACTIVE_STATUSES.has(status) && customerId && subscriptionId && variantId) {
            await ctx.runMutation(internal.billing.activateSubscription, {
              userId,
              lemonSqueezyCustomerId: customerId,
              lemonSqueezySubscriptionId: subscriptionId,
              lemonSqueezyVariantId: variantId,
              subscriptionStatus: status as
                | "on_trial"
                | "active"
                | "paused"
                | "past_due"
                | "unpaid"
                | "cancelled"
                | "expired",
              subscriptionRenewsAt: renewsAt,
              subscriptionEndsAt: endsAt,
            });
          }
          break;
        }
        case "subscription_cancelled": {
          // Access continues until the current period ends — do not
          // downgrade the plan yet, only record the status + end date.
          await ctx.runMutation(internal.billing.markCancelled, {
            userId,
            subscriptionEndsAt: endsAt,
          });
          break;
        }
        case "subscription_expired": {
          await ctx.runMutation(internal.billing.expireSubscription, { userId });
          break;
        }
        default:
          // Other event types (e.g. subscription_paused, order_created) are
          // logged for audit via billingEvents but need no user-record change.
          break;
      }
    } catch (err) {
      console.error(`[lemonsqueezy webhook] failed to apply event ${eventId}:`, err);
      return new Response("Internal error", { status: 500 });
    }

    return new Response("OK", { status: 200 });
  }),
});

export default http;
