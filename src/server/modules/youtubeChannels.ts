// Port of convex/youtubeChannels.ts. Export ONLY rpc definitions from this file.
// Not ported: `addOrUpdate` (browser-supplied channel id + tokens cannot be verified; the OAuth
// callback uses saveYoutubeConnection in lib/accounts/channels.ts, the single add path and the
// one that enforces the free-plan limit and cross-account uniqueness), `migrateFromLegacy`
// (the legacy single-channel columns no longer exist), and the internal* helpers.
import { z } from "zod";
import { listChannelsForUser, removeChannel, setPrimaryChannel } from "@/server/lib/accounts/channels";
import { mutation, query } from "../rpc/define";

/** The user's connected channels (no tokens), oldest first. */
export const list = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return [];
    return listChannelsForUser(ctx.db, ctx.userId);
  },
});

/** Disconnect one channel (by YouTube channel id). The oldest remaining channel becomes primary. */
export const remove = mutation({
  input: z.object({ channelId: z.string().min(1).max(100) }),
  handler: async (ctx, args) => {
    await removeChannel(ctx.db, ctx.userId, args.channelId);
  },
});

/** Make a channel the one used when a video has no explicit channel. */
export const setPrimary = mutation({
  input: z.object({ channelId: z.string().min(1).max(100) }),
  handler: async (ctx, args) => {
    await setPrimaryChannel(ctx.db, ctx.userId, args.channelId);
  },
});
