/**
 * Connected YouTube channels: every write path lives here so the rules cannot diverge
 * between the OAuth callback route and the rpc functions.
 *
 *  - Tokens are stored encrypted (src/server/crypto.ts); nothing here returns them.
 *  - A YouTube channel can be linked to ONE account (global unique index on channel_id).
 *  - Free plan: one channel. The first channel of a user becomes primary; at most one
 *    primary per user (partial unique index), so switching is "unset old, then set new"
 *    in one transaction.
 *  - Every mutation takes a per-user lock first (`FOR NO KEY UPDATE` on the users row: it
 *    serialises this user's channel changes without blocking foreign-key inserts), because
 *    Postgres READ COMMITTED would otherwise let two callbacks both pass the plan-limit
 *    count, or two "first channel" inserts both claim primary.
 *  - Removing a channel / revoking access deletes the user's YouTube-derived analytics
 *    (purgeUserAnalytics, agent E). Note it is user-wide, not per-channel.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { users, youtubeChannels } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { purgeUserAnalytics } from "@/server/lib/analytics/purge";
import { conflict, notFound, planLimit } from "@/server/rpc/errors";

export type ChannelRow = typeof youtubeChannels.$inferSelect;

/** What the browser may see of a channel: never tokens. */
export function channelDto(row: ChannelRow) {
  return {
    id: row.id,
    channelId: row.channelId,
    channelName: row.channelName,
    oauthStatus: row.oauthStatus,
    isPrimary: row.isPrimary,
    tokenExpiry: row.tokenExpiry,
    createdAt: row.createdAt,
  };
}

export async function listChannelsForUser(db: DbLike, userId: string) {
  const rows = await db.select().from(youtubeChannels).where(eq(youtubeChannels.userId, userId)).orderBy(asc(youtubeChannels.createdAt), asc(youtubeChannels.id));
  return rows.map(channelDto);
}

/** Serialise this user's channel mutations for the rest of the surrounding transaction. */
async function lockUser(tx: DbLike, userId: string): Promise<void> {
  const rows = await tx.execute(sql`select 1 from users where id = ${userId} for no key update`);
  if ((rows as unknown as unknown[]).length === 0) throw notFound("User not found");
}

export type SaveConnectionInput = {
  channelId: string;
  channelName?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  /** Seconds, as returned by Google's token endpoint. */
  expiresIn: number;
};

/**
 * Link (or re-link) a YouTube channel to a user after a verified OAuth exchange.
 * The ONLY add/update path: the OAuth callback calls it, and it is deliberately not an rpc
 * (a browser-supplied channel id + tokens would be unverifiable).
 *
 * Throws CONFLICT when the channel belongs to another account, and a PLAN_LIMIT_EXCEEDED
 * error (`PLAN_LIMIT_EXCEEDED:youtubeChannels:free`) when a free user would exceed one channel.
 * Re-connecting a channel the user already owns is always allowed and keeps the old refresh
 * token when Google did not send a new one.
 */
export async function saveYoutubeConnection(db: DbLike, userId: string, input: SaveConnectionInput): Promise<{ id: string; isPrimary: boolean }> {
  const accessToken = encryptSecret(input.accessToken);
  const refreshToken = input.refreshToken ? encryptSecret(input.refreshToken) : null;
  const tokenExpiry = new Date(Date.now() + Math.max(input.expiresIn, 0) * 1000);

  return db.transaction(async (tx) => {
    await lockUser(tx, userId);

    // Ownership first (clearer error than the plan limit when someone else's channel is claimed).
    const [claimed] = await tx
      .select({ userId: youtubeChannels.userId })
      .from(youtubeChannels)
      .where(eq(youtubeChannels.channelId, input.channelId))
      .limit(1);
    if (claimed && claimed.userId !== userId) throw conflict("This YouTube channel is already connected to another account.");

    const owned = await tx
      .select({ channelId: youtubeChannels.channelId })
      .from(youtubeChannels)
      .where(eq(youtubeChannels.userId, userId));
    const isReconnect = owned.some((c) => c.channelId === input.channelId);

    if (!isReconnect) {
      const [u] = await tx.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1);
      const plan = u?.plan ?? "free";
      if (plan === "free" && owned.length >= 1) throw planLimit(`PLAN_LIMIT_EXCEEDED:youtubeChannels:${plan}`);
    }

    // One atomic statement decides ownership: the DO UPDATE only fires for this user's own row.
    const [row] = await tx
      .insert(youtubeChannels)
      .values({
        userId,
        channelId: input.channelId,
        channelName: input.channelName ?? null,
        accessToken,
        refreshToken,
        tokenExpiry,
        oauthStatus: "connected",
        isPrimary: owned.length === 0,
      })
      .onConflictDoUpdate({
        target: youtubeChannels.channelId,
        set: {
          channelName: sql`coalesce(excluded.channel_name, ${youtubeChannels.channelName})`,
          accessToken: sql`excluded.access_token`,
          refreshToken: sql`coalesce(excluded.refresh_token, ${youtubeChannels.refreshToken})`,
          tokenExpiry: sql`excluded.token_expiry`,
          oauthStatus: "connected",
          updatedAt: new Date(),
        },
        setWhere: eq(youtubeChannels.userId, userId),
      })
      .returning({ id: youtubeChannels.id, isPrimary: youtubeChannels.isPrimary });

    if (!row) throw conflict("This YouTube channel is already connected to another account.");
    return row;
  });
}

/** Make one of the user's channels (by YouTube channel id) the primary. Unset-then-set in one transaction. */
export async function setPrimaryChannel(db: DbLike, userId: string, channelId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const [target] = await tx
      .select({ id: youtubeChannels.id, isPrimary: youtubeChannels.isPrimary })
      .from(youtubeChannels)
      .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.channelId, channelId)))
      .limit(1);
    if (!target) throw notFound("Channel not found");
    if (target.isPrimary) return;
    // Two statements on purpose: the partial unique index is checked row by row.
    await tx.update(youtubeChannels).set({ isPrimary: false, updatedAt: new Date() }).where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.isPrimary, true)));
    await tx.update(youtubeChannels).set({ isPrimary: true, updatedAt: new Date() }).where(eq(youtubeChannels.id, target.id));
  });
}

/** Disconnect one channel; promotes the oldest remaining channel when the primary was removed. */
export async function removeChannel(db: DbLike, userId: string, channelId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUser(tx, userId);
    const [channel] = await tx
      .select({ id: youtubeChannels.id, isPrimary: youtubeChannels.isPrimary })
      .from(youtubeChannels)
      .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.channelId, channelId)))
      .limit(1);
    if (!channel) throw notFound("Channel not found or not owned by this user");

    await tx.delete(youtubeChannels).where(eq(youtubeChannels.id, channel.id));
    if (channel.isPrimary) {
      await tx.execute(sql`
        update youtube_channels set is_primary = true, updated_at = now()
        where id = (select id from youtube_channels where user_id = ${userId} order by created_at asc, id asc limit 1)
      `);
    }
    await purgeUserAnalytics(tx, userId);
  });
}

/** Disconnect every channel of the user (Settings -> Disconnect). */
export async function disconnectAllChannels(db: DbLike, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockUser(tx, userId);
    await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, userId));
    await purgeUserAnalytics(tx, userId);
  });
}
