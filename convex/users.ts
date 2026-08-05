import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { getCurrentUserOrThrow } from "./lib/auth";

async function getUserBySupabaseId(ctx: any, supabaseId: string) {
  return ctx.db
    .query("users")
    .withIndex("by_supabase_id", (q: any) => q.eq("supabaseId", supabaseId))
    .unique();
}

export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);

    // Returning user — fast path
    const existing = await getUserBySupabaseId(ctx, identity.subject);
    if (existing) {
      if (existing.name !== identity.name) {
        await ctx.db.patch(existing._id, { name: identity.name });
      }
      return existing._id;
    }

    // Migrated user: find by email so all their existing videos/settings stay linked
    if (identity.email) {
      const byEmail = await ctx.db
        .query("users")
        .withIndex("by_email", (q: any) => q.eq("email", identity.email))
        .unique();

      if (byEmail) {
        await ctx.db.patch(byEmail._id, {
          supabaseId: identity.subject,
          name: identity.name ?? byEmail.name,
          imageUrl: identity.pictureUrl ?? byEmail.imageUrl,
        });
        return byEmail._id;
      }
    }

    // Brand new user
    return ctx.db.insert("users", {
      supabaseId: identity.subject,
      email: identity.email!,
      name: identity.name,
      imageUrl: identity.pictureUrl,
      youtubeConnected: false,
    });
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return getUserBySupabaseId(ctx, identity.subject);
  },
});

export const saveYoutubeTokens = mutation({
  args: {
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.number(),
    channelName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await getUserBySupabaseId(ctx, identity.subject);
    if (!user) throw new Error("User not found");
    await ctx.db.patch(user._id, {
      youtubeConnected: true,
      youtubeChannelName: args.channelName,
      youtubeAccessToken: args.accessToken,
      youtubeRefreshToken: args.refreshToken,
      youtubeTokenExpiry: Date.now() + args.expiresIn * 1000,
    });
  },
});

export const disconnectYoutube = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await getUserBySupabaseId(ctx, identity.subject);
    if (!user) throw new Error("User not found");
    await ctx.db.patch(user._id, {
      youtubeConnected: false,
      youtubeChannelName: undefined,
      youtubeAccessToken: undefined,
      youtubeRefreshToken: undefined,
      youtubeTokenExpiry: undefined,
    });
  },
});

export const internalGetById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => ctx.db.get(args.userId),
});

export const internalSetYoutubeOAuthStatus = internalMutation({
  args: {
    userId: v.id("users"),
    status: v.union(
      v.literal("connected"),
      v.literal("token_expired"),
      v.literal("revoked"),
      v.literal("unknown"),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { youtubeOAuthStatus: args.status });
  },
});

export const internalUpdateYoutubeTokens = internalMutation({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    expiresIn: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      youtubeAccessToken: args.accessToken,
      youtubeTokenExpiry: Date.now() + args.expiresIn * 1000,
    });
  },
});

// Kept for data-import compatibility only — not used in new code
export const upsertFromClerk = internalMutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .unique();
    if (user) {
      await ctx.db.patch(user._id, { name: args.name, imageUrl: args.imageUrl, email: args.email });
    } else {
      await ctx.db.insert("users", { clerkId: args.clerkId, email: args.email, name: args.name, imageUrl: args.imageUrl, youtubeConnected: false });
    }
  },
});

export const deleteFromClerk = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", args.clerkId))
      .unique();
    if (user) await ctx.db.delete(user._id);
  },
});

// ---------------------------------------------------------------------------
// OAuth health status
// ---------------------------------------------------------------------------

const oauthStatusValidator = v.union(
  v.literal("connected"),
  v.literal("token_expired"),
  v.literal("revoked"),
  v.literal("unknown"),
);

/** Public mutation — lets the current user update their own OAuth status. */
export const updateOAuthStatus = mutation({
  args: { status: oauthStatusValidator },
  handler: async (ctx, args) => {
    const identity = await getCurrentUserOrThrow(ctx);
    const user = await getUserBySupabaseId(ctx, identity.subject);
    if (!user) throw new Error("User not found");
    await ctx.db.patch(user._id, { youtubeOAuthStatus: args.status });
  },
});

/** Internal mutation — used by the OAuth health-check cron/action. */
export const internalUpdateOAuthStatus = internalMutation({
  args: { userId: v.id("users"), status: oauthStatusValidator },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { youtubeOAuthStatus: args.status });
  },
});

/** Public query — returns the current user's OAuth status fields. */
export const getOAuthStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await getUserBySupabaseId(ctx, identity.subject);
    if (!user) return null;
    return {
      youtubeOAuthStatus: user.youtubeOAuthStatus,
      youtubeConnected: user.youtubeConnected,
      youtubeChannelName: user.youtubeChannelName,
    };
  },
});

/** Internal query — returns all users who have YouTube connected.
 *  Used by the OAuth health-check cron to iterate all connected accounts.
 *  Full table scan is acceptable for the current user count; add an index
 *  on youtubeConnected if this becomes a bottleneck.
 */
export const listConnectedUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allUsers = await ctx.db.query("users").collect();
    return allUsers.filter((u) => u.youtubeConnected === true);
  },
});
