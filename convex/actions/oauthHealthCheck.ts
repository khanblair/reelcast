"use node";

import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { refreshYouTubeToken } from "../lib/youtube";

type OAuthStatus = "connected" | "token_expired" | "revoked" | "unknown";

/**
 * Internal action — checks YouTube OAuth health for a single user.
 *
 * Steps:
 *  1. Load user record.
 *  2. No access token → patch status="unknown", return.
 *  3. GET https://www.googleapis.com/youtube/v3/channels?part=id&mine=true
 *  4. 200 → patch status="connected".
 *  5. 401 → try refresh. Success → persist new token + "connected".
 *              Failure → "revoked".
 *  6. Other error → "unknown".
 */
export const checkUserOAuthHealth = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<{ userId: string; status: OAuthStatus }> => {
    const user = await ctx.runQuery(internal.users.internalGetById, {
      userId: args.userId,
    });

    if (!user || !user.youtubeAccessToken) {
      await ctx.runMutation(internal.users.internalUpdateOAuthStatus, {
        userId: args.userId,
        status: "unknown",
      });
      return { userId: args.userId, status: "unknown" };
    }

    // --- Step 3: probe the YouTube API ---
    let response: Response;
    try {
      response = await fetch(
        "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true",
        { headers: { Authorization: `Bearer ${user.youtubeAccessToken}` } }
      );
    } catch (err) {
      console.error(`[oauthHealthCheck] Network error for user ${args.userId}:`, err);
      await ctx.runMutation(internal.users.internalUpdateOAuthStatus, {
        userId: args.userId,
        status: "unknown",
      });
      return { userId: args.userId, status: "unknown" };
    }

    // --- Step 4: 200 OK ---
    if (response.ok) {
      await ctx.runMutation(internal.users.internalUpdateOAuthStatus, {
        userId: args.userId,
        status: "connected",
      });
      return { userId: args.userId, status: "connected" };
    }

    // --- Step 5: 401 → attempt token refresh ---
    if (response.status === 401) {
      if (!user.youtubeRefreshToken) {
        // No refresh token to try — treat as revoked
        await ctx.runMutation(internal.users.internalUpdateOAuthStatus, {
          userId: args.userId,
          status: "revoked",
        });
        return { userId: args.userId, status: "revoked" };
      }

      try {
        const { accessToken, expiresIn } = await refreshYouTubeToken(
          user.youtubeRefreshToken
        );
        // Persist the refreshed token so future uploads work without re-auth
        await ctx.runMutation(internal.users.internalUpdateYoutubeTokens, {
          userId: args.userId,
          accessToken,
          expiresIn,
        });
        await ctx.runMutation(internal.users.internalUpdateOAuthStatus, {
          userId: args.userId,
          status: "connected",
        });
        return { userId: args.userId, status: "connected" };
      } catch {
        // refreshYouTubeToken throws on failure — treat as revoked
        await ctx.runMutation(internal.users.internalUpdateOAuthStatus, {
          userId: args.userId,
          status: "revoked",
        });
        return { userId: args.userId, status: "revoked" };
      }
    }

    // --- Step 6: other HTTP error ---
    console.warn(
      `[oauthHealthCheck] Unexpected status ${response.status} for user ${args.userId}`
    );
    await ctx.runMutation(internal.users.internalUpdateOAuthStatus, {
      userId: args.userId,
      status: "unknown",
    });
    return { userId: args.userId, status: "unknown" };
  },
});

/**
 * Public action — checks the current authenticated user's OAuth health.
 * Useful for the UI to display a badge or warning banner.
 */
export const checkMyOAuthHealth = action({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.runQuery(api.users.current);
    if (!user) throw new Error("Unauthenticated");
    return ctx.runAction(
      internal.actions.oauthHealthCheck.checkUserOAuthHealth,
      { userId: user._id }
    );
  },
});

/**
 * Internal action — iterates all YouTube-connected users and health-checks
 * each one sequentially to avoid hammering the YouTube API.
 * Called by the cron job every 6 hours.
 */
export const checkAllUsersOAuthHealth = internalAction({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.runQuery(internal.users.listConnectedUsers);
    console.log(`[oauthHealthCheck] Checking ${users.length} connected user(s)`);

    for (const user of users) {
      try {
        const result = await ctx.runAction(
          internal.actions.oauthHealthCheck.checkUserOAuthHealth,
          { userId: user._id }
        );
        console.log(`[oauthHealthCheck] user=${user._id} status=${result.status}`);
      } catch (err) {
        // Isolate per-user failures so the remaining users still get checked
        console.error(`[oauthHealthCheck] Unhandled error for user ${user._id}:`, err);
      }
    }
  },
});
