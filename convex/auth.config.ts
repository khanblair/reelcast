export default {
  providers: [
    {
      domain: process.env.CLERK_ISSUER_URL || "https://genuine-dingo-34.clerk.accounts.dev",
      applicationID: "convex",
    },
  ]
};
