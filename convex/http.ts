import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

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

export default http;
