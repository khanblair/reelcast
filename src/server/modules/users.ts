// Port of convex/users.ts. Export ONLY rpc definitions from this file.
// `store` is gone (src/server/auth.ts ensureUser creates the row on first request),
// `saveYoutubeTokens` is the plain function saveYoutubeConnection in lib/accounts/channels.ts
// (the OAuth callback calls it; it must not be browser-callable), and the Convex
// `updateOAuthStatus` (let a client set its own OAuth health) was unused and is dropped.
import { getChannelSummary, userDto } from "@/server/lib/dto";
import { disconnectAllChannels } from "@/server/lib/accounts/channels";
import { mutation, query } from "../rpc/define";

/** The signed-in user (no tokens, ever), or null when signed out. */
export const current = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.user) return null;
    return userDto(ctx.user, await getChannelSummary(ctx.db, ctx.user.id));
  },
});

/** Disconnect YouTube: removes every connected channel and the analytics derived from them. */
export const disconnectYoutube = mutation({
  handler: async (ctx) => {
    await disconnectAllChannels(ctx.db, ctx.userId);
  },
});
