// Port of convex/admin/users.ts. EVERY function is admin-only (the Convex version had NO auth:
// anyone could call setAdmin/setPlan). Responses are DTOs: no tokens, no BYOK keys, no webhook
// URLs; "has key" booleans only.
import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/client";
import { PLANS, jobs, settings, users, videos, youtubeChannels } from "@/db/schema";
import { getChannelSummary } from "@/server/lib/dto";
import { badRequest, conflict, notFound } from "../../rpc/errors";
import { mutation, query } from "../../rpc/define";

/** Booleans computed inside SQL so the secret values never leave the database. */
const has = (col: SQL | unknown) => sql<boolean>`coalesce(${col}, '') <> ''`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Users, newest first. Search / plan filtering happens in SQL so it works beyond the row cap. */
export const listAll = query({
  auth: "admin",
  input: z.object({
    limit: z.number().int().min(1).max(500).optional(),
    search: z.string().trim().max(100).optional(),
    plan: z.enum(PLANS).optional(),
  }),
  handler: async (ctx, args) => {
    const primary = ctx.db
      .select({ userId: youtubeChannels.userId, oauthStatus: youtubeChannels.oauthStatus })
      .from(youtubeChannels)
      .where(eq(youtubeChannels.isPrimary, true))
      .as("primary_channel");

    const conds: SQL[] = [];
    if (args.search) {
      const pat = `%${escapeLike(args.search)}%`;
      const m = or(ilike(users.email, pat), ilike(users.name, pat));
      if (m) conds.push(m);
    }
    if (args.plan) conds.push(eq(users.plan, args.plan));

    return ctx.db
      .select({
        id: users.id,
        createdAt: users.createdAt,
        email: users.email,
        name: users.name,
        imageUrl: users.imageUrl,
        plan: users.plan,
        planSource: users.planSource,
        isAdmin: users.isAdmin,
        youtubeConnected: sql<boolean>`${primary.userId} is not null`,
        youtubeOAuthStatus: primary.oauthStatus,
        autoPublishEnabled: sql<boolean>`coalesce(${settings.autoPublishEnabled}, false)`,
        hasDiscordWebhook: has(settings.discordWebhookUrl),
        hasTelegram: has(settings.telegramChatId),
        hasResendApiKey: has(settings.resendApiKey),
      })
      .from(users)
      .leftJoin(primary, eq(primary.userId, users.id))
      .leftJoin(settings, eq(settings.userId, users.id))
      .where(and(...conds))
      .orderBy(desc(users.createdAt))
      .limit(args.limit ?? 200);
  },
});

const VIDEO_LIMIT = 200;

async function adminUserDto(db: DbLike, userId: string) {
  const [u] = await db
    .select({
      id: users.id,
      createdAt: users.createdAt,
      email: users.email,
      name: users.name,
      imageUrl: users.imageUrl,
      plan: users.plan,
      planSource: users.planSource,
      isAdmin: users.isAdmin,
      autoPublishEnabled: sql<boolean>`coalesce(${settings.autoPublishEnabled}, false)`,
      hasDiscordWebhook: has(settings.discordWebhookUrl),
      hasTelegram: has(settings.telegramChatId),
      hasResendApiKey: has(settings.resendApiKey),
      hasDeepseekApiKey: has(settings.deepseekApiKey),
    })
    .from(users)
    .leftJoin(settings, eq(settings.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return null;
  return { ...u, ...(await getChannelSummary(db, userId)) };
}

/** One user with their (latest 200) videos and last 20 jobs. null when the user does not exist. */
export const getWithDetails = query({
  auth: "admin",
  input: z.object({ userId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const user = await adminUserDto(ctx.db, args.userId);
    if (!user) return null;

    const [videoRows, [videoTotal], recentJobs] = await Promise.all([
      ctx.db
        .select({
          id: videos.id,
          createdAt: videos.createdAt,
          title: videos.title,
          status: videos.status,
          publishedAt: videos.publishedAt,
          scheduledPublishAt: videos.scheduledPublishAt,
          rawFileSize: videos.rawFileSize,
        })
        .from(videos)
        .where(eq(videos.userId, args.userId))
        .orderBy(desc(videos.createdAt))
        .limit(VIDEO_LIMIT),
      ctx.db.select({ n: count() }).from(videos).where(eq(videos.userId, args.userId)),
      ctx.db
        .select({
          id: jobs.id,
          createdAt: jobs.createdAt,
          type: jobs.type,
          status: jobs.status,
          error: jobs.error,
          startedAt: jobs.startedAt,
          completedAt: jobs.completedAt,
        })
        .from(jobs)
        .where(eq(jobs.userId, args.userId))
        .orderBy(desc(jobs.createdAt))
        .limit(20),
    ]);

    return { user, videos: videoRows, videoCount: videoTotal.n, recentJobs };
  },
});

/**
 * Grant or revoke admin. Refuses self-demotion and refuses to remove the LAST admin.
 * Concurrency: demotions serialise on a row lock over every current admin, so two admins
 * demoting each other at the same time cannot leave the platform with zero admins.
 */
export const setAdmin = mutation({
  auth: "admin",
  input: z.object({ userId: z.string().uuid(), isAdmin: z.boolean() }),
  handler: async (ctx, args) => {
    if (!args.isAdmin && args.userId === ctx.userId) {
      throw badRequest("You cannot remove your own admin access");
    }
    if (args.isAdmin) {
      const rows = await ctx.db
        .update(users)
        .set({ isAdmin: true, updatedAt: new Date() })
        .where(eq(users.id, args.userId))
        .returning({ id: users.id });
      if (rows.length === 0) throw notFound("User not found");
      return;
    }

    await ctx.db.transaction(async (tx) => {
      // Lock all admin rows (id order => no deadlocks) and count them under the lock.
      const admins = (await tx.execute(sql`select id from users where is_admin order by id for update`)) as unknown as { id: string }[];
      const target = admins.find((a) => a.id === args.userId);
      if (!target) {
        const [exists] = await tx.select({ id: users.id }).from(users).where(eq(users.id, args.userId)).limit(1);
        if (!exists) throw notFound("User not found");
        return; // already not an admin
      }
      if (admins.length <= 1) throw conflict("Cannot remove the last remaining admin");
      await tx.update(users).set({ isAdmin: false, updatedAt: new Date() }).where(eq(users.id, args.userId));
    });
  },
});

/**
 * Set a user's plan by hand. `plan_source` records who decided: 'admin' when granting
 * pro/elite (so a lapsing subscription does not wipe the grant), 'default' for free.
 */
export const setPlan = mutation({
  auth: "admin",
  input: z.object({ userId: z.string().uuid(), plan: z.enum(PLANS) }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .update(users)
      .set({ plan: args.plan, planSource: args.plan === "free" ? "default" : "admin", updatedAt: new Date() })
      .where(eq(users.id, args.userId))
      .returning({ id: users.id });
    if (rows.length === 0) throw notFound("User not found");
  },
});
