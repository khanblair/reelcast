import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

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
// PayPal webhook
// ---------------------------------------------------------------------------
//
// Registered via convex/actions/paypal.ts registerWebhook (admin-only
// action), which calls PayPal's webhooks API with this route's URL and
// stores the returned webhook_id. PayPal signs every delivery with a
// certificate (not a pre-shared HMAC secret), so verification itself is an
// API call — verify-webhook-signature — rather than something we can check
// locally with Web Crypto.
http.route({
  path: "/webhooks/paypal",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    try {
      JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const transmissionId = request.headers.get("paypal-transmission-id");
    const transmissionTime = request.headers.get("paypal-transmission-time");
    const transmissionSig = request.headers.get("paypal-transmission-sig");
    const certUrl = request.headers.get("paypal-cert-url");
    const authAlgo = request.headers.get("paypal-auth-algo");

    if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
      console.error("[paypal webhook] missing signature headers");
      return new Response("Missing signature headers", { status: 400 });
    }

    try {
      const verified = await ctx.runAction(internal.actions.paypalWebhook.verifyAndApply, {
        rawBody,
        authAlgo,
        certUrl,
        transmissionId,
        transmissionSig,
        transmissionTime,
      });
      if (!verified) {
        console.error("[paypal webhook] signature verification failed");
        return new Response("Invalid signature", { status: 401 });
      }
    } catch (err) {
      console.error("[paypal webhook] failed to process event:", err);
      return new Response("Internal error", { status: 500 });
    }

    return new Response("OK", { status: 200 });
  }),
});

export default http;
