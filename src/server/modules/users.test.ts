import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import {
  aiMessages, aiSessions, contactSubmissions, generations, ideas, jobs, notifications, paymentEvents, paymentOrders,
  settings, subscriptions, tasks, usageLedger, users, videoAnalytics, videoDailyStats, videoMetadataVersions, videos,
  youtubeChannels, youtubeQuotaUsage,
} from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { ensureUser } from "@/server/auth";
import { avatarFolder, avatarPrefix, newAvatarId } from "@/server/lib/accounts/avatar";
import { deleteAccountForUser, getAccountSummary, type DeleteAccountDeps } from "@/server/lib/accounts/deleteAccount";
import { updateProfileForUser, type ProfileDeps } from "@/server/lib/accounts/profile";
import type { CloudinaryImageInfo } from "@/server/lib/cloudinary";
import { RpcError, type RpcErrorCode } from "@/server/rpc/errors";
import { callRpc, inRolledBackTx } from "../testing";

setDefaultTimeout(120_000);

process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ??= "test-cloud";
const CLOUD = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
const videoUrl = (name: string, cloud = CLOUD) => `https://res.cloudinary.com/${cloud}/video/upload/v1/${name}.mp4`;
const avatarUrl = (userId: string, id = newAvatarId(), ext = "jpg") =>
  `https://res.cloudinary.com/${CLOUD}/image/upload/v1700000000/${avatarFolder(userId)}/${id}.${ext}`;
const publicIdOf = (url: string) => /\/upload\/(?:v\d+\/)?(.+)\.[a-z]+$/.exec(url)![1];

const GOOD_INFO: CloudinaryImageInfo = { resourceType: "image", type: "upload", format: "jpg", bytes: 2000, width: 512, height: 512 };

function profileDeps(over: Partial<ProfileDeps> = {}) {
  const destroyed: string[] = [];
  const deps: ProfileDeps = {
    getImageInfo: async () => GOOD_INFO,
    destroyAssets: async (ids) => void destroyed.push(...ids),
    ...over,
  };
  return { deps, destroyed };
}

const userRow = async (tx: DbLike, id: string) => (await tx.select().from(users).where(eq(users.id, id)))[0];
const rejectsWith = async (p: Promise<unknown>, code: RpcErrorCode) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcError);
    expect((e as RpcError).code).toBe(code);
    return e as RpcError;
  }
  throw new Error(`expected a ${code} error`);
};

// ─── users.updateProfile ─────────────────────────────────────────────────────

describe("users.updateProfile", () => {
  test("changes the name through the RPC, never the email, and only for the caller", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser({ name: "Other Person" });
      const out = (await callRpc("users.updateProfile", { name: "  Ada   Lovelace " }, { user, tx })) as { name: string };
      expect(out.name).toBe("Ada Lovelace");

      const after = await userRow(tx, user.id);
      expect(after.name).toBe("Ada Lovelace");
      expect(after.email).toBe(user.email);
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());
      expect((await userRow(tx, other.id)).name).toBe("Other Person");

      const me = (await callRpc("users.current", {}, { user: after, tx })) as { name?: string; email: string };
      expect(me).toMatchObject({ name: "Ada Lovelace", email: user.email });
    });
  });

  test("rejects the email, other fields, bad names and signed-out callers", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await rejectsWith(callRpc("users.updateProfile", { name: "Ada", email: "evil@example.com" }, { user, tx }), "BAD_REQUEST");
      await rejectsWith(callRpc("users.updateProfile", { name: "Ada", isAdmin: true }, { user, tx }), "BAD_REQUEST");
      await rejectsWith(callRpc("users.updateProfile", { name: "   " }, { user, tx }), "BAD_REQUEST");
      await rejectsWith(callRpc("users.updateProfile", { name: "x".repeat(61) }, { user, tx }), "BAD_REQUEST");
      await rejectsWith(callRpc("users.updateProfile", {}, { user, tx }), "BAD_REQUEST");
      await rejectsWith(callRpc("users.updateProfile", { name: "Ada" }, { user: null, tx }), "UNAUTHENTICATED");
      const after = await userRow(tx, user.id);
      expect(after.email).toBe(user.email);
      expect(after.isAdmin).toBe(false);
      expect(after.name).toBe(user.name);
    });
  });

  test("picture: a verified upload is stored and the previous one of ours is deleted", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const first = avatarUrl(user.id);
      const second = avatarUrl(user.id);
      const { deps, destroyed } = profileDeps();

      expect(await updateProfileForUser(tx, user, { imageUrl: first }, deps)).toMatchObject({ imageUrl: first });
      expect(destroyed).toEqual([]); // nothing to clean up the first time

      const current = await userRow(tx, user.id);
      expect(await updateProfileForUser(tx, current, { imageUrl: second, name: "Ada" }, deps)).toMatchObject({ imageUrl: second, name: "Ada" });
      expect(destroyed).toEqual([publicIdOf(first)]);
      expect((await userRow(tx, user.id)).imageUrl).toBe(second);

      // Saving the picture that is already current deletes nothing.
      destroyed.length = 0;
      await updateProfileForUser(tx, await userRow(tx, user.id), { imageUrl: second }, deps);
      expect(destroyed).toEqual([]);
    });
  });

  test("picture: removing it clears the column and deletes our file, but never touches a Google picture", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const mine = avatarUrl(user.id);
      await tx.update(users).set({ imageUrl: mine }).where(eq(users.id, user.id));
      const { deps, destroyed } = profileDeps();
      expect(await updateProfileForUser(tx, await userRow(tx, user.id), { imageUrl: null }, deps)).toMatchObject({ imageUrl: null });
      expect(destroyed).toEqual([publicIdOf(mine)]);
      expect((await userRow(tx, user.id)).imageUrl).toBeNull();

      // A picture that came from Google is not ours to delete when it is replaced.
      const google = await makeUser({ imageUrl: "https://lh3.googleusercontent.com/a/abc=s96-c" });
      const g = profileDeps();
      await updateProfileForUser(tx, google, { imageUrl: avatarUrl(google.id) }, g.deps);
      expect(g.destroyed).toEqual([]);
    });
  });

  test("picture: refuses another user's file, foreign URLs, and anything Cloudinary does not confirm", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const keep = avatarUrl(user.id);
      await tx.update(users).set({ imageUrl: keep }).where(eq(users.id, user.id));
      const current = await userRow(tx, user.id);
      const { deps, destroyed } = profileDeps();

      for (const bad of [
        avatarUrl(other.id), // somebody else's picture
        "https://example.com/me.jpg",
        `https://res.cloudinary.com/some-other-cloud/image/upload/v1/${avatarFolder(user.id)}/${newAvatarId()}.jpg`,
        "javascript:alert(1)",
      ]) {
        await rejectsWith(updateProfileForUser(tx, current, { imageUrl: bad }, deps), "BAD_REQUEST");
      }

      const fresh = avatarUrl(user.id);
      await rejectsWith(updateProfileForUser(tx, current, { imageUrl: fresh }, profileDeps({ getImageInfo: async () => null }).deps), "BAD_REQUEST"); // not uploaded
      await rejectsWith(updateProfileForUser(tx, current, { imageUrl: fresh }, profileDeps({ getImageInfo: async () => ({ ...GOOD_INFO, bytes: 6 * 1024 * 1024 }) }).deps), "BAD_REQUEST"); // too big
      await rejectsWith(updateProfileForUser(tx, current, { imageUrl: fresh }, profileDeps({ getImageInfo: async () => ({ ...GOOD_INFO, resourceType: "video" }) }).deps), "BAD_REQUEST");
      await rejectsWith(updateProfileForUser(tx, current, { imageUrl: fresh }, profileDeps({ getImageInfo: async () => { throw new Error("network down"); } }).deps), "BAD_REQUEST");

      // Every refusal left the stored picture alone and deleted nothing.
      expect((await userRow(tx, user.id)).imageUrl).toBe(keep);
      expect(destroyed).toEqual([]);
    });
  });

  test("picture: a failed cleanup of the old file never fails the save", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const old = avatarUrl(user.id);
      await tx.update(users).set({ imageUrl: old }).where(eq(users.id, user.id));
      const next = avatarUrl(user.id);
      const { deps } = profileDeps({ destroyAssets: async () => { throw new Error("cloudinary 500"); } });
      expect(await updateProfileForUser(tx, await userRow(tx, user.id), { imageUrl: next }, deps)).toMatchObject({ imageUrl: next });
    });
  });
});

// ─── account deletion ────────────────────────────────────────────────────────

/** One row in every table that belongs to a user, plus rows that must SURVIVE (another user's) for contrast. */
async function seedAccount(tx: DbLike, user: typeof users.$inferSelect, other: typeof users.$inferSelect) {
  const mkVideo = async (owner: string, over: Partial<typeof videos.$inferInsert> = {}) =>
    (await tx.insert(videos).values({ userId: owner, title: "t", rawFileSize: 1, rawFileKey: videoUrl(`raw-${randomUUID()}`), ...over }).returning())[0];

  const v1 = await mkVideo(user.id, { rawFileKey: videoUrl("v1-raw"), processedFileKey: videoUrl("v1-processed") });
  const sharedUrl = videoUrl("shared-with-other");
  const v2 = await mkVideo(user.id, { rawFileKey: sharedUrl });
  await mkVideo(other.id, { rawFileKey: sharedUrl }); // another user's row points at the same file: it must NOT be deleted
  await mkVideo(user.id, { rawFileKey: videoUrl("foreign-cloud", "not-our-cloud") }); // a file in somebody else's cloud
  await mkVideo(user.id, { rawFileKey: "https://example.com/not-cloudinary.mp4" });
  const otherVideo = await mkVideo(other.id, { rawFileKey: videoUrl("other-users-own-file") });

  await tx.insert(videoMetadataVersions).values({ videoId: v1.id, aiTitle: "old" });
  await tx.insert(jobs).values({ userId: user.id, videoId: v1.id, type: "publish" });
  await tx.insert(generations).values({
    userId: user.id, videoId: v1.id, model: "veo", prompt: "p", resolution: "720p", aspectRatio: "16:9", durationSeconds: 8,
    generateAudio: false, outputVideoUrl: videoUrl("v1-generated"),
  });
  await tx.insert(videoAnalytics).values({ userId: user.id, videoId: v1.id, youtubeVideoId: "yt1", day: "2026-01-01" });
  await tx.insert(videoDailyStats).values({ userId: user.id, videoId: v1.id, day: "2026-01-01" });
  await tx.insert(ideas).values({ userId: user.id, title: "idea" });
  const [session] = await tx.insert(aiSessions).values({ userId: user.id }).returning();
  await tx.insert(aiMessages).values({ userId: user.id, sessionId: session.id, role: "user", content: "hello" });
  await tx.insert(notifications).values({ userId: user.id, type: "info", title: "t", message: "m" });
  await tx.insert(settings).values({ userId: user.id });
  const [sub] = await tx.insert(subscriptions).values({ userId: user.id, plan: "pro", status: "active" }).returning();
  await tx.insert(usageLedger).values({ userId: user.id, month: "2026-01" });
  await tx.insert(youtubeQuotaUsage).values({ userId: user.id, date: "2026-01-01" });
  await tx.insert(youtubeChannels).values({
    userId: user.id, channelId: `UC${randomUUID()}`, accessToken: encryptSecret("access-secret"), refreshToken: encryptSecret("refresh-secret"), tokenExpiry: new Date(),
  });
  await tx.insert(tasks).values({ kind: "own", userId: user.id });
  const [ghostTask] = await tx.insert(tasks).values({ kind: "metadata", payload: { videoId: v1.id } }).returning(); // no user id of its own

  const merchantRef = `mr-${randomUUID()}`;
  const trackingId = `tr-${randomUUID()}`;
  await tx.insert(paymentOrders).values({ userId: user.id, subscriptionId: sub.id, merchantRef, orderTrackingId: trackingId, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" });
  await tx.insert(paymentEvents).values({ payload: { n: 1 }, merchantRef, orderTrackingId: trackingId });
  await tx.insert(paymentEvents).values({ payload: { n: 2 }, orderTrackingId: trackingId }); // matched by tracking id only
  const otherRef = `mr-${randomUUID()}`;
  await tx.insert(paymentOrders).values({ userId: other.id, merchantRef: otherRef, orderTrackingId: `tr-${randomUUID()}`, purpose: "initial", plan: "pro", amount: "19.00", currency: "USD" });
  await tx.insert(paymentEvents).values({ payload: { n: 3 }, merchantRef: otherRef });

  await tx.insert(contactSubmissions).values({ name: "n", email: user.email.toUpperCase(), subject: "s", message: "m" });
  await tx.insert(contactSubmissions).values({ name: "n", email: other.email, subject: "s", message: "m" });
  await tx.insert(ideas).values({ userId: other.id, title: "theirs" });

  return { v1, v2, otherVideo, ghostTask, merchantRef, trackingId, otherRef };
}

function deleteDeps(over: Partial<DeleteAccountDeps> = {}) {
  const calls = { assets: [] as { ids: string[]; type: string }[], prefixes: [] as { prefix: string; type: string }[], revoked: [] as string[] };
  const deps: DeleteAccountDeps = {
    destroyAssets: async (ids, type) => void calls.assets.push({ ids: [...ids].sort(), type }),
    destroyPrefix: async (prefix, type) => void calls.prefixes.push({ prefix, type }),
    revokeToken: async (token) => void calls.revoked.push(token),
    now: () => Date.now(),
    ...over,
  };
  return { deps, calls };
}

/** Every column (table, column) holding a foreign key to public.users, read from the live catalog. */
async function userForeignKeys(tx: DbLike) {
  const rows = (await tx.execute(sql`
    select c.conrelid::regclass::text as tbl, a.attname as col,
           case c.confdeltype when 'c' then 'CASCADE' when 'n' then 'SET NULL' when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' else 'OTHER' end as on_delete
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.contype = 'f' and c.confrelid = 'public.users'::regclass
     order by 1, 2`)) as unknown as { tbl: string; col: string; on_delete: string }[];
  return rows.filter((r) => r.tbl !== "users");
}

const countWhere = async (tx: DbLike, table: string, column: string, value: string) =>
  ((await tx.execute(sql`select count(*)::int as n from ${sql.raw(table)} where ${sql.raw(column)} = ${value}`)) as unknown as { n: number }[])[0].n;

describe("account deletion", () => {
  test("removes every trace of the account, keeps everyone else's data, and cleans up storage and Google first", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const seed = await seedAccount(tx, user, other);
      const { deps, calls } = deleteDeps();

      // A real auth identity for this user (the app role may delete it; see deleteAccount.ts).
      await tx.execute(sql`insert into auth.users (id, email, aud, role) values (${user.id}, ${user.email}, 'authenticated', 'authenticated')`);

      await deleteAccountForUser(tx, user, `  ${user.email.toUpperCase()} `, deps);

      // Storage: exactly this user's own Cloudinary video files, and their avatar folder.
      expect(calls.assets).toEqual([{ ids: ["v1-generated", "v1-processed", "v1-raw"], type: "video" }]);
      expect(calls.prefixes).toEqual([{ prefix: avatarPrefix(user.id), type: "image" }]);
      // Google: the refresh token of the connected channel, decrypted.
      expect(calls.revoked).toEqual(["refresh-secret"]);

      // The account, its sign-in identity and all data are gone.
      expect(await userRow(tx, user.id)).toBeUndefined();
      expect(await countWhere(tx, "auth.users", "id", user.id)).toBe(0);
      for (const fk of await userForeignKeys(tx)) {
        if (fk.on_delete === "SET NULL") continue;
        expect({ table: fk.tbl, rows: await countWhere(tx, fk.tbl, fk.col, user.id) }).toEqual({ table: fk.tbl, rows: 0 });
      }
      expect(await countWhere(tx, "video_metadata_versions", "video_id", seed.v1.id)).toBe(0);

      // Rows that carry the user's data without pointing at the user.
      expect(await countWhere(tx, "payment_events", "merchant_ref", seed.merchantRef)).toBe(0);
      expect(await countWhere(tx, "payment_events", "order_tracking_id", seed.trackingId)).toBe(0);
      expect(await countWhere(tx, "contact_submissions", "lower(email)", user.email.toLowerCase())).toBe(0);
      expect((await tx.select().from(tasks).where(eq(tasks.id, seed.ghostTask.id)))[0].status).toBe("cancelled");

      // Everyone else is untouched.
      expect(await userRow(tx, other.id)).toBeDefined();
      expect(await countWhere(tx, "videos", "user_id", other.id)).toBe(2);
      expect(await countWhere(tx, "ideas", "user_id", other.id)).toBe(1);
      expect(await countWhere(tx, "payment_orders", "user_id", other.id)).toBe(1);
      expect(await countWhere(tx, "payment_events", "merchant_ref", seed.otherRef)).toBe(1);
      expect(await countWhere(tx, "contact_submissions", "email", other.email)).toBe(1);
    });
  });

  test("storage is asked to delete only files this user alone owns", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      await seedAccount(tx, user, other);
      const { deps, calls } = deleteDeps();
      await deleteAccountForUser(tx, user, user.email, deps);
      expect(calls.assets).toHaveLength(1);
      const ids = calls.assets[0].ids;
      expect(ids).toEqual(["v1-generated", "v1-processed", "v1-raw"]); // not the shared one, the foreign cloud, nor the non-Cloudinary URL
      expect(ids).not.toContain("shared-with-other");
    });
  });

  test("a wrong email, or the only admin, is refused before anything is touched", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      await seedAccount(tx, user, other);
      const { deps, calls } = deleteDeps();

      await rejectsWith(deleteAccountForUser(tx, user, "someone-else@example.com", deps), "BAD_REQUEST");
      await rejectsWith(callRpc("users.deleteAccount", { confirmEmail: "nope@example.com" }, { user, tx }), "BAD_REQUEST");
      await rejectsWith(callRpc("users.deleteAccount", {}, { user, tx }), "BAD_REQUEST");
      await rejectsWith(callRpc("users.deleteAccount", { confirmEmail: user.email }, { user: null, tx }), "UNAUTHENTICATED");

      // Make this user the only admin (the dev database has a real admin; demote it inside this rolled-back transaction).
      await tx.update(users).set({ isAdmin: false }).where(sql`is_admin = true`);
      await tx.update(users).set({ isAdmin: true }).where(eq(users.id, user.id));
      const admin = await userRow(tx, user.id);
      expect((await getAccountSummary(tx, admin)).blockedReason).toBe("last_admin");
      await rejectsWith(deleteAccountForUser(tx, admin, admin.email, deps), "CONFLICT");

      expect(calls.assets).toEqual([]);
      expect(calls.prefixes).toEqual([]);
      expect(calls.revoked).toEqual([]);
      expect(await userRow(tx, user.id)).toBeDefined();
      expect(await countWhere(tx, "videos", "user_id", user.id)).toBe(4);

      // With another admin around, an admin may delete their own account.
      await tx.update(users).set({ isAdmin: true }).where(eq(users.id, other.id));
      expect((await getAccountSummary(tx, admin)).blockedReason).toBeNull();
    });
  });

  test("if storage cannot be cleaned, nothing else is deleted and the account stays intact", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const seed = await seedAccount(tx, user, other);
      const failing = deleteDeps({ destroyAssets: async () => { throw new Error("cloudinary is down"); } });

      const err = await rejectsWith(deleteAccountForUser(tx, user, user.email, failing.deps), "INTERNAL");
      expect(err.message).toContain("nothing was deleted");
      expect(failing.calls.revoked).toEqual([]); // Google was not touched either

      const prefixFails = deleteDeps({ destroyPrefix: async () => { throw new Error("prefix failed"); } });
      await rejectsWith(deleteAccountForUser(tx, user, user.email, prefixFails.deps), "INTERNAL");

      expect(await userRow(tx, user.id)).toBeDefined();
      expect(await countWhere(tx, "videos", "user_id", user.id)).toBe(4);
      expect(await countWhere(tx, "payment_orders", "user_id", user.id)).toBe(1);
      expect(await countWhere(tx, "payment_events", "merchant_ref", seed.merchantRef)).toBe(1);
      expect(await countWhere(tx, "contact_submissions", "lower(email)", user.email.toLowerCase())).toBe(1);

      // A retry (storage works again) finishes the job.
      await deleteAccountForUser(tx, user, user.email, deleteDeps().deps);
      expect(await userRow(tx, user.id)).toBeUndefined();
    });
  });

  test("a Google revoke failure does not block deleting the account; an account with no videos skips the video cleanup", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.insert(youtubeChannels).values({ userId: user.id, channelId: `UC${randomUUID()}`, accessToken: encryptSecret("a"), refreshToken: encryptSecret("r"), tokenExpiry: new Date() });
      const { deps, calls } = deleteDeps({ revokeToken: async () => { throw new Error("google 500"); } });
      await deleteAccountForUser(tx, user, user.email, deps);
      expect(calls.assets).toEqual([]); // no video files: no bulk delete call at all
      expect(calls.prefixes).toHaveLength(1);
      expect(await userRow(tx, user.id)).toBeUndefined();
    });
  });

  test("deletionSummary reports what will be removed", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      await seedAccount(tx, user, other);
      const s = (await callRpc("users.deletionSummary", {}, { user, tx })) as Awaited<ReturnType<typeof getAccountSummary>>;
      expect(s).toMatchObject({ email: user.email, videoCount: 4, channelCount: 1, ideaCount: 1, aiSessionCount: 1, hasActiveSubscription: true });
      expect(s.blockedReason).toBeUndefined(); // null is omitted on the wire
      expect(s.storageBytes).toBe(4);
      await rejectsWith(callRpc("users.deletionSummary", {}, { user: null, tx }), "UNAUTHENTICATED");
    });
  });
});

// ─── guards that keep "delete everything" true as the schema grows ───────────

describe("deletion guards", () => {
  test("every foreign key to users cascades (or, for the reviewer on a payment order, clears)", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const fks = await userForeignKeys(tx);
      expect(fks.length).toBeGreaterThanOrEqual(15);
      const notCascading = fks.filter((fk) => fk.on_delete !== "CASCADE").map((fk) => `${fk.tbl}.${fk.col} ${fk.on_delete}`);
      expect(notCascading).toEqual(["payment_orders.reviewed_by SET NULL"]);

      // ...and users itself hangs off auth.users, so deleting the auth identity removes the app user.
      const [authFk] = (await tx.execute(sql`
        select case c.confdeltype when 'c' then 'CASCADE' else 'OTHER' end as on_delete
          from pg_constraint c where c.contype = 'f' and c.conrelid = 'public.users'::regclass and c.confrelid = 'auth.users'::regclass`)) as unknown as { on_delete: string }[];
      expect(authFk?.on_delete).toBe("CASCADE");
    });
  });

  test("no table can hold user data without being cascaded or handled by deleteAccount", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const tables = ((await tx.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)) as unknown as { table_name: string }[]).map((r) => r.table_name);
      const fkRows = (await tx.execute(sql`
        select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
               c.confdeltype = 'c' as cascades
          from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace`)) as unknown as { child: string; parent: string; cascades: boolean }[];

      // A table is covered when a chain of CASCADE foreign keys leads from it to users.
      const covered = new Set<string>(["users"]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const fk of fkRows) {
          if (fk.cascades && covered.has(fk.parent) && !covered.has(fk.child)) {
            covered.add(fk.child);
            changed = true;
          }
        }
      }
      const handledByDeleteAccount = ["contact_submissions", "payment_events"]; // matched by email / payment reference
      const globalTables = ["platform_settings", "job_schedules"]; // site-wide singletons and sweep clocks: no user data
      const uncovered = tables.filter((t) => !covered.has(t) && !handledByDeleteAccount.includes(t) && !globalTables.includes(t)).sort();
      // If this fails, a new table holds data that account deletion would leave behind: give it
      // `userId ... references(() => users.id, { onDelete: "cascade" })`, or handle it in deleteAccount.ts.
      expect(uncovered).toEqual([]);
    });
  });
});

// ─── a token that outlives its account ───────────────────────────────────────

describe("ensureUser", () => {
  test("a still-valid token of a deleted account reads as signed out, not as a server error", async () => {
    // users.id references auth.users(id): with no auth row the insert is refused, and must not come back as a 500.
    const err = await rejectsWith(ensureUser({ sub: randomUUID(), email: `ghost-${randomUUID()}@example.test` }), "UNAUTHENTICATED");
    expect(err.message).toContain("no longer exists");
  });
});
