/**
 * Permanent account deletion.
 *
 * What "delete everything" means here, in the order it happens:
 *  1. Files in Cloudinary: every video file the user uploaded or generated, and every profile picture. Done FIRST and
 *     all-or-nothing: if storage cannot be cleaned, nothing else is touched and the user can simply try again (files
 *     already gone count as deleted, so a retry finishes the job). Deleting the rows first would orphan files nobody
 *     could ever find or remove again.
 *  2. The YouTube grants are revoked at Google (best effort; the tokens are deleted with the rows anyway).
 *  3. One database transaction: the contact-form messages that carry this email and the raw payment notifications of
 *     this user's orders (the only user data not keyed by user id), then the Supabase auth user. Every user-owned table references `users(id) ON DELETE CASCADE` and `users`
 *     references `auth.users(id) ON DELETE CASCADE`, so deleting the auth user removes the sign-in identity, sessions,
 *     the app user and ALL of its data in one statement. `users` is deleted explicitly too, so the app data is removed
 *     even if an auth row is missing. A test asserts that every foreign key to `users` cascades.
 *
 * Nothing here can touch another user: the id comes from the session and the caller must type their own email.
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { contactSubmissions, generations, ideas, aiSessions, subscriptions, users, videos, youtubeChannels } from "@/db/schema";
import { decryptOptional, decryptSecret } from "@/server/crypto";
import {
  destroyCloudinaryAssets,
  destroyCloudinaryPrefix,
  extractCloudinaryPublicId,
  isAllowedMediaUrl,
  type CloudinaryResourceType,
} from "@/server/lib/cloudinary";
import { revokeGoogleToken } from "@/server/lib/youtube/revoke";
import type { UserRow } from "@/server/rpc/define";
import { RpcError, badRequest, conflict } from "@/server/rpc/errors";
import { avatarPrefix } from "./avatar";

/** What the delete screen shows before the user confirms. Counts only: nothing here is a secret. */
export type AccountSummary = {
  email: string;
  plan: string;
  videoCount: number;
  storageBytes: number;
  channelCount: number;
  ideaCount: number;
  aiSessionCount: number;
  hasActiveSubscription: boolean;
  /** Set when the account cannot be deleted right now. */
  blockedReason: "last_admin" | null;
};

export async function getAccountSummary(db: DbLike, user: UserRow): Promise<AccountSummary> {
  const count = sql<number>`count(*)::int`;
  const [videoStats] = await db
    .select({ n: count, bytes: sql<number>`coalesce(sum(${videos.rawFileSize}), 0)::float8` })
    .from(videos)
    .where(eq(videos.userId, user.id));
  const [channels] = await db.select({ n: count }).from(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
  const [ideaStats] = await db.select({ n: count }).from(ideas).where(eq(ideas.userId, user.id));
  const [sessions] = await db.select({ n: count }).from(aiSessions).where(eq(aiSessions.userId, user.id));
  const [subs] = await db
    .select({ n: count })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, ["active", "past_due"])));

  let blockedReason: AccountSummary["blockedReason"] = null;
  if (user.isAdmin) {
    const [others] = await db.select({ n: count }).from(users).where(and(eq(users.isAdmin, true), ne(users.id, user.id)));
    if (others.n === 0) blockedReason = "last_admin";
  }

  return {
    email: user.email,
    plan: user.plan,
    videoCount: videoStats.n,
    storageBytes: videoStats.bytes,
    channelCount: channels.n,
    ideaCount: ideaStats.n,
    aiSessionCount: sessions.n,
    hasActiveSubscription: subs.n > 0,
    blockedReason,
  };
}

export type DeleteAccountDeps = {
  destroyAssets: (publicIds: string[], resourceType: CloudinaryResourceType, opts: { deadline: number }) => Promise<void>;
  destroyPrefix: (prefix: string, resourceType: CloudinaryResourceType, opts: { deadline: number }) => Promise<void>;
  revokeToken: (token: string) => Promise<void>;
  now: () => number;
};
export const defaultDeleteAccountDeps = (): DeleteAccountDeps => ({
  destroyAssets: (ids, type, opts) => destroyCloudinaryAssets(ids, type, opts),
  destroyPrefix: (prefix, type, opts) => destroyCloudinaryPrefix(prefix, type, opts),
  revokeToken: (token) => revokeGoogleToken(token),
  now: () => Date.now(),
});

const IN_ARRAY_CHUNK = 500;
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Public ids of the video files this user owns. File keys are client-supplied, so a crafted key could point at
 * somebody else's file; a file that any OTHER user's rows also reference is therefore left alone.
 */
export async function collectOwnedVideoPublicIds(db: DbLike, userId: string): Promise<string[]> {
  const own = new Set<string>();
  for (const r of await db.select({ a: videos.rawFileKey, b: videos.processedFileKey }).from(videos).where(eq(videos.userId, userId))) {
    for (const url of [r.a, r.b]) if (isAllowedMediaUrl(url)) own.add(url);
  }
  for (const r of await db.select({ u: generations.outputVideoUrl }).from(generations).where(eq(generations.userId, userId))) {
    if (isAllowedMediaUrl(r.u)) own.add(r.u);
  }

  const sharedWithOthers = new Set<string>();
  for (const part of chunks([...own], IN_ARRAY_CHUNK)) {
    const inVideos = await db
      .select({ a: videos.rawFileKey, b: videos.processedFileKey })
      .from(videos)
      .where(and(ne(videos.userId, userId), or(inArray(videos.rawFileKey, part), inArray(videos.processedFileKey, part))));
    for (const r of inVideos) for (const url of [r.a, r.b]) if (url && part.includes(url)) sharedWithOthers.add(url);
    const inGenerations = await db
      .select({ u: generations.outputVideoUrl })
      .from(generations)
      .where(and(ne(generations.userId, userId), inArray(generations.outputVideoUrl, part)));
    for (const r of inGenerations) if (r.u) sharedWithOthers.add(r.u);
  }

  const publicIds = new Set<string>();
  for (const url of own) {
    if (sharedWithOthers.has(url)) continue;
    const id = extractCloudinaryPublicId(url);
    if (id) publicIds.add(id);
  }
  return [...publicIds];
}

/** Revoke every connected channel's grant at Google. Never throws: the rows are deleted afterwards regardless. */
async function revokeChannelGrants(db: DbLike, userId: string, revoke: DeleteAccountDeps["revokeToken"]): Promise<void> {
  const rows = await db
    .select({ accessToken: youtubeChannels.accessToken, refreshToken: youtubeChannels.refreshToken })
    .from(youtubeChannels)
    .where(eq(youtubeChannels.userId, userId));
  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        // Revoking the refresh token also invalidates its access tokens.
        const token = decryptOptional(row.refreshToken) ?? decryptSecret(row.accessToken);
        await revoke(token);
      } catch (err) {
        console.warn("[deleteAccount] could not revoke a Google grant:", err instanceof Error ? err.message : err);
      }
    }),
  );
}

const STORAGE_FAILED =
  "We could not remove your files from storage, so nothing was deleted. Your account is unchanged; please try again in a minute.";

export async function deleteAccountForUser(
  db: DbLike,
  user: UserRow,
  confirmEmail: string,
  deps: DeleteAccountDeps = defaultDeleteAccountDeps(),
): Promise<void> {
  if (confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
    throw badRequest("The email you typed does not match your account.");
  }
  const summary = await getAccountSummary(db, user);
  if (summary.blockedReason === "last_admin") {
    throw conflict("You are the only admin. Make another user an admin before deleting this account.");
  }

  // 1. Files first (see the header).
  const deadline = deps.now() + 240_000;
  try {
    const publicIds = await collectOwnedVideoPublicIds(db, user.id);
    if (publicIds.length > 0) await deps.destroyAssets(publicIds, "video", { deadline });
    await deps.destroyPrefix(avatarPrefix(user.id), "image", { deadline });
  } catch (err) {
    console.error("[deleteAccount] storage cleanup failed:", err instanceof Error ? err.message : err);
    throw new RpcError("INTERNAL", STORAGE_FAILED);
  }

  // 2. Google grants.
  await revokeChannelGrants(db, user.id, deps.revokeToken);

  // 3. The database.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from users where id = ${user.id} for update`);
    // The two tables that hold this user's data without a foreign key to them:
    await tx.delete(contactSubmissions).where(sql`lower(${contactSubmissions.email}) = lower(${user.email})`);
    // Raw payment notifications are matched to an order by reference, not by user, so they would survive the cascade.
    await tx.execute(sql`
      delete from payment_events
       where merchant_ref in (select merchant_ref from payment_orders where user_id = ${user.id})
          or order_tracking_id in (select order_tracking_id from payment_orders where user_id = ${user.id} and order_tracking_id is not null)
    `);
    // Pending background work for this user's videos (it may carry no user id of its own) must not run for a ghost.
    await tx.execute(sql`
      update tasks set status = 'cancelled', updated_at = now()
       where status = 'pending' and payload->>'videoId' in (select id::text from videos where user_id = ${user.id})
    `);
    await tx.execute(sql`delete from auth.users where id = ${user.id}`);
    await tx.delete(users).where(eq(users.id, user.id));
  });
  console.info(`[deleteAccount] account ${user.id} deleted`);
}
