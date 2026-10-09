// Port of convex/actions/oauthHealthCheck.ts (public actions only; the 6-hourly sweep is a job handler).
// Export ONLY rpc definitions from this file.
import { checkAllChannels, checkUserOAuthHealth } from "@/server/lib/publish/oauth";
import { action } from "../../rpc/define";

/** Probe the caller's YouTube connection(s). `status` is the primary channel's. */
export const checkMyOAuthHealth = action({
  handler: async (ctx) => checkUserOAuthHealth(ctx.db, ctx.userId),
});

/**
 * Admin: probe every connected channel of every user. Bounded to ~25s; `checked < total` means the
 * time ran out and another click continues with the channels that were checked longest ago.
 */
export const checkAllChannelsOAuthHealth = action({
  auth: "admin",
  handler: async (ctx) => checkAllChannels(ctx.db, { deadline: Date.now() + 25_000 }),
});
