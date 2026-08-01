const authConfig = {
  providers: [
    {
      // Must be the convex.site URL — Convex cloud fetches JWKS from this domain
      // and it must be publicly reachable (localhost never works from Convex cloud).
      // CONVEX_SITE_URL is a built-in that resolves to localhost in dev — use a custom var.
      domain: process.env.AUTH_ISSUER_URL,
      applicationID: "reelcast",
    },
  ],
};

export default authConfig;
