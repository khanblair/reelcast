// Port of convex/users.ts. Export ONLY rpc definitions from this file.
// `store` is gone (src/server/auth.ts ensureUser creates the row on first request),
// `saveYoutubeTokens` is the plain function saveYoutubeConnection in lib/accounts/channels.ts
// (the OAuth callback calls it; it must not be browser-callable), and the Convex
// `updateOAuthStatus` (let a client set its own OAuth health) was unused and is dropped.
import { z } from "zod";
import { getChannelSummary, userDto } from "@/server/lib/dto";
import { disconnectAllChannels } from "@/server/lib/accounts/channels";
import { deleteAccountForUser, getAccountSummary } from "@/server/lib/accounts/deleteAccount";
import { profileInput, updateProfileForUser } from "@/server/lib/accounts/profile";
import { action, mutation, query } from "../rpc/define";

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

/**
 * Change the caller's own name and/or profile picture (never the email). `imageUrl` is a picture the browser just
 * uploaded to the caller's avatar folder, or null to remove it; the server re-checks it with Cloudinary.
 */
export const updateProfile = action({
  input: profileInput,
  handler: (ctx, args) => updateProfileForUser(ctx.db, ctx.user, args),
});

/** What deleting the account would remove, for the confirmation screen. */
export const deletionSummary = query({
  handler: (ctx) => getAccountSummary(ctx.db, ctx.user),
});

/**
 * Permanently delete the caller's account and everything in it (files, database rows, sign-in identity). The caller
 * must type their own email. See src/server/lib/accounts/deleteAccount.ts.
 */
export const deleteAccount = action({
  input: z.object({ confirmEmail: z.string().min(1).max(320) }).strict(),
  handler: async (ctx, { confirmEmail }) => {
    await deleteAccountForUser(ctx.db, ctx.user, confirmEmail);
  },
});
