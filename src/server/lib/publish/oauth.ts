/**
 * YouTube OAuth health: is each connected channel's token still accepted by Google?
 * Port of convex/actions/oauthHealthCheck.ts for the multi-channel `youtube_channels` table.
 *
 * Token access/refresh goes through getValidAccessToken (agent B), which also records
 * 'connected' / 'token_expired' / 'revoked' when it has to refresh. This module adds the live probe
 * (channels.list, 1 quota unit) and the user-facing notice when a channel becomes revoked.
 */
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { youtubeChannels } from "@/db/schema";
import { probeChannelAccess, YOUTUBE_CHANNELS_LIST_QUOTA_UNITS } from "@/server/lib/youtube";
import { bestEffort, defaultDeps, type PublishDeps } from "./deps";

export type OAuthStatus = "connected" | "token_expired" | "revoked" | "unknown";
type ChannelRow = typeof youtubeChannels.$inferSelect;

/** What a failed token fetch means, read from the status getValidAccessToken recorded (no message matching). */
async function statusAfterTokenFailure(db: DbLike, channelRowId: string): Promise<OAuthStatus> {
  const [row] = await db.select({ s: youtubeChannels.oauthStatus }).from(youtubeChannels).where(eq(youtubeChannels.id, channelRowId)).limit(1);
  return row?.s === "revoked" || row?.s === "token_expired" ? row.s : "unknown";
}

/** Record the status unless the channel was re-connected meanwhile (its refresh token changed). */
async function writeStatus(db: DbLike, row: ChannelRow, status: OAuthStatus): Promise<void> {
  await db.execute(sql`
    update youtube_channels
       set oauth_status = ${status}, updated_at = now()
     where id = ${row.id} and refresh_token is not distinct from ${row.refreshToken}::text
  `);
}

export async function checkChannelOAuthHealth(db: DbLike, channelRowId: string, deps: PublishDeps = defaultDeps()): Promise<OAuthStatus> {
  const [row] = await db.select().from(youtubeChannels).where(eq(youtubeChannels.id, channelRowId)).limit(1);
  if (!row) return "unknown";
  const previous = row.oauthStatus;

  const finish = async (status: OAuthStatus): Promise<OAuthStatus> => {
    await bestEffort("record oauth status", () => writeStatus(db, row, status));
    // Tell the user once, when the channel BECOMES revoked (not on every 6-hourly re-check).
    if (status === "revoked" && previous !== "revoked") {
      const name = row.channelName ?? "your channel";
      await bestEffort("revoked notification", () =>
        deps.createNotification(db, {
          userId: row.userId,
          title: "YouTube connection lost",
          message: `YouTube access for ${name} was revoked. Reconnect it to keep publishing.`,
          type: "error",
          link: "/settings/youtube",
        }),
      );
    }
    return status;
  };

  let accessToken: string;
  try {
    accessToken = (await deps.getValidAccessToken(db, row.id)).accessToken;
  } catch {
    return finish(await statusAfterTokenFailure(db, row.id));
  }

  await bestEffort("quota accounting", () => deps.addYoutubeQuota(db, row.userId, YOUTUBE_CHANNELS_LIST_QUOTA_UNITS));
  const probe = await probeChannelAccess(accessToken, deps.fetch);
  if (probe.ok) return finish("connected");

  if (probe.status === 401) {
    // Google rejected a token we believed valid: force a refresh (mark it expired, ask for a fresh one).
    await bestEffort("expire token", () =>
      db.update(youtubeChannels).set({ tokenExpiry: new Date(Date.now() - 60_000) }).where(eq(youtubeChannels.id, row.id)),
    );
    try {
      await deps.getValidAccessToken(db, row.id);
      return finish("connected");
    } catch {
      return finish(await statusAfterTokenFailure(db, row.id));
    }
  }

  console.warn(`[oauthHealth] unexpected status ${probe.status} for channel ${row.id}`);
  return finish("unknown");
}

/** The caller's own channels. `status` is the PRIMARY channel's (what the settings page shows). */
export async function checkUserOAuthHealth(
  db: DbLike,
  userId: string,
  deps: PublishDeps = defaultDeps(),
): Promise<{ userId: string; status: OAuthStatus }> {
  const rows = await db
    .select({ id: youtubeChannels.id })
    .from(youtubeChannels)
    .where(eq(youtubeChannels.userId, userId))
    .orderBy(desc(youtubeChannels.isPrimary), asc(youtubeChannels.createdAt));
  if (rows.length === 0) return { userId, status: "unknown" };
  const statuses = await Promise.all(rows.map((r) => checkChannelOAuthHealth(db, r.id, deps).catch((): OAuthStatus => "unknown")));
  return { userId, status: statuses[0] };
}

/**
 * Check every connected channel, 5 at a time, least recently checked first, stopping at `deadline`.
 * One channel's failure never stops the others. Calling again continues where this stopped.
 */
export async function checkAllChannels(
  db: DbLike,
  opts: { deadline: number; concurrency?: number; deps?: PublishDeps; /** Test seam: only these channel rows. */ channelIds?: string[] },
): Promise<{ checked: number; total: number }> {
  const deps = opts.deps ?? defaultDeps();
  const concurrency = opts.concurrency ?? 5;
  const ids = await db
    .select({ id: youtubeChannels.id })
    .from(youtubeChannels)
    .where(opts.channelIds ? inArray(youtubeChannels.id, opts.channelIds) : undefined)
    .orderBy(asc(youtubeChannels.updatedAt));
  let checked = 0;
  for (let i = 0; i < ids.length && Date.now() < opts.deadline; i += concurrency) {
    const results = await Promise.allSettled(ids.slice(i, i + concurrency).map((r) => checkChannelOAuthHealth(db, r.id, deps)));
    for (const r of results) {
      if (r.status === "fulfilled") checked++;
      else console.error("[oauthHealth] channel check threw:", r.reason instanceof Error ? r.reason.message : r.reason);
    }
  }
  return { checked, total: ids.length };
}
