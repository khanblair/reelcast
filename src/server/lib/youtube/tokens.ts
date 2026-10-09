/**
 * YouTube OAuth token access for background jobs and rpc actions (contract owned by agent B).
 *
 *   getValidAccessToken(db, youtubeChannelRowId) -> { accessToken, channelId }
 *   getPrimaryChannelRow(db, userId)             -> the user's primary youtube_channels row | null
 *
 * Tokens live encrypted in youtube_channels (AES-256-GCM). This module is the only place
 * that decrypts them for use and the only place that refreshes them:
 *  - an access token is reused while it has more than REFRESH_SKEW_MS left;
 *  - otherwise it is refreshed with the stored refresh token, the new access token is
 *    persisted ENCRYPTED and the channel is marked 'connected';
 *  - Google answering `invalid_grant` means the user revoked access (or the grant expired):
 *    the channel is marked 'revoked', the user's analytics are purged (YouTube API Services
 *    policy) and a NonRetryableError is thrown so queue handlers stop retrying;
 *  - any other refresh failure marks the channel 'token_expired' and throws a plain
 *    (retryable) Error.
 *
 * Concurrency: no lock is held across the Google call. Two simultaneous refreshes both
 * succeed and the last write wins (both tokens are valid). Writes are compare-and-swap on
 * the stored refresh-token ciphertext, so a refresh that raced with a re-connect (new
 * tokens saved by the OAuth callback) never overwrites or revokes the fresh connection.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { youtubeChannels } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { NonRetryableError } from "@/server/jobs/handlers";
import { purgeUserAnalytics } from "@/server/lib/analytics/purge";

export type YoutubeChannelRow = typeof youtubeChannels.$inferSelect;
export type OAuthStatus = NonNullable<YoutubeChannelRow["oauthStatus"]>;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh when the access token has less than this left. */
const REFRESH_SKEW_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * The user's primary channel row (raw: tokens are still encrypted), or null when none is connected.
 * Strictly `is_primary` (same rule as getChannelSummary in dto.ts, so jobs never publish to a
 * channel the UI says is not connected). The channel code keeps the invariant "a user with
 * channels always has exactly one primary" (first channel becomes primary, removal promotes).
 */
export async function getPrimaryChannelRow(db: DbLike, userId: string): Promise<YoutubeChannelRow | null> {
  const [row] = await db
    .select()
    .from(youtubeChannels)
    .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.isPrimary, true)))
    .limit(1);
  return row ?? null;
}

/** Set a channel's OAuth status unless a newer connection replaced the credentials we used. */
async function setStatusIfUnchanged(db: DbLike, row: YoutubeChannelRow, status: OAuthStatus): Promise<boolean> {
  const updated = await db
    .update(youtubeChannels)
    .set({ oauthStatus: status, updatedAt: new Date() })
    // `is not distinct from` also matches "still no refresh token" (null = null).
    .where(and(eq(youtubeChannels.id, row.id), sql`${youtubeChannels.refreshToken} is not distinct from ${row.refreshToken}::text`))
    .returning({ id: youtubeChannels.id });
  return updated.length > 0;
}

/** Mark a channel revoked and delete the analytics derived from the revoked grant. Never throws. */
async function markRevoked(db: DbLike, row: YoutubeChannelRow): Promise<void> {
  try {
    if (await setStatusIfUnchanged(db, row, "revoked")) await purgeUserAnalytics(db, row.userId);
  } catch (e) {
    console.error("[youtube/tokens] failed to record revoked channel", e instanceof Error ? e.message : e);
  }
}

async function markTokenExpired(db: DbLike, row: YoutubeChannelRow): Promise<void> {
  try {
    await setStatusIfUnchanged(db, row, "token_expired");
  } catch (e) {
    console.error("[youtube/tokens] failed to record token_expired", e instanceof Error ? e.message : e);
  }
}

/**
 * Decrypt a stored token. A failure here is a SERVER problem (missing/rotated APP_ENCRYPTION_KEY,
 * corrupt ciphertext), never evidence that the user revoked access, so callers must not change
 * the channel's status or purge data because of it.
 */
function decryptStored(blob: string): string {
  try {
    return decryptSecret(blob);
  } catch (e) {
    throw new Error(`Stored YouTube credentials could not be decrypted: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

type RefreshOutcome =
  | { ok: true; accessToken: string; expiresInSec: number; refreshToken?: string }
  | { ok: false; invalidGrant: boolean; message: string };

async function callGoogleRefresh(refreshToken: string): Promise<RefreshOutcome> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured on the server");

  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, invalidGrant: false, message: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }

  let body: { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; error?: unknown; error_description?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON body: handled below via res.ok / status
  }

  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
    return { ok: false, invalidGrant: code === "invalid_grant", message: code };
  }
  if (typeof body.access_token !== "string" || !body.access_token) {
    return { ok: false, invalidGrant: false, message: "no access_token in refresh response" };
  }
  const expiresInSec = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    ok: true,
    accessToken: body.access_token,
    expiresInSec,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined,
  };
}

/**
 * A usable access token for the given youtube_channels row id (NOT the YouTube channel id),
 * plus the YouTube channel id. Refreshes and persists when needed (see file header).
 * Throws NonRetryableError when the channel is gone or its grant is revoked/unreadable.
 */
export async function getValidAccessToken(db: DbLike, youtubeChannelRowId: string): Promise<{ accessToken: string; channelId: string }> {
  const [row] = await db.select().from(youtubeChannels).where(eq(youtubeChannels.id, youtubeChannelRowId)).limit(1);
  if (!row) throw new NonRetryableError("YouTube channel is not connected");

  if (row.tokenExpiry.getTime() - REFRESH_SKEW_MS > Date.now()) {
    return { accessToken: decryptStored(row.accessToken), channelId: row.channelId };
  }

  // Needs a refresh.
  if (row.oauthStatus === "revoked") {
    throw new NonRetryableError("YouTube access was revoked. Reconnect your YouTube account.");
  }
  if (!row.refreshToken) {
    // Google never issued a refresh token for this connection: only a reconnect can fix it.
    await markRevoked(db, row);
    throw new NonRetryableError("No YouTube refresh token on file. Reconnect your YouTube account.");
  }
  const refreshToken = decryptStored(row.refreshToken);

  const out = await callGoogleRefresh(refreshToken);
  if (!out.ok) {
    if (out.invalidGrant) {
      await markRevoked(db, row);
      throw new NonRetryableError("YouTube access was revoked or expired. Reconnect your YouTube account.");
    }
    await markTokenExpired(db, row);
    throw new Error(`YouTube token refresh failed: ${out.message}`);
  }

  const persisted = await db
    .update(youtubeChannels)
    .set({
      accessToken: encryptSecret(out.accessToken),
      tokenExpiry: new Date(Date.now() + out.expiresInSec * 1000),
      oauthStatus: "connected",
      updatedAt: new Date(),
      ...(out.refreshToken ? { refreshToken: encryptSecret(out.refreshToken) } : {}),
    })
    .where(and(eq(youtubeChannels.id, row.id), eq(youtubeChannels.refreshToken, row.refreshToken)))
    .returning({ id: youtubeChannels.id });

  if (persisted.length === 0) {
    // The row changed under us. If it is gone the user disconnected; if it was re-connected
    // the OAuth callback already stored fresh tokens, and the one we just minted is still valid.
    const [again] = await db.select({ id: youtubeChannels.id }).from(youtubeChannels).where(eq(youtubeChannels.id, row.id)).limit(1);
    if (!again) throw new NonRetryableError("YouTube channel is not connected");
  }
  return { accessToken: out.accessToken, channelId: row.channelId };
}
