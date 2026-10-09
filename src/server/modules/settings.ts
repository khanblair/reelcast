// Port of convex/settings.ts. Export ONLY rpc definitions from this file.
// Not ported: `getByUserId` / `getByVideoUserId` (leaked every key to any caller; server code reads
// the table directly), and the dummy `testYoutubeConnection` / `testTelegramConnection` mutations
// (the UI uses actions.testConnections.*).
import { and, eq, sql } from "drizzle-orm";
import { settings } from "@/db/schema";
import { buildSettingsValues, assertAutoPublishArgs, settingsUpdateInput, startAutoPublishInput } from "@/server/lib/accounts/settings";
import { getChannelSummary, settingsDto } from "@/server/lib/dto";
import { cancelTask, enqueueTask } from "@/server/jobs/queue";
import { kickRunner } from "@/server/jobs/kick";
import { mutation, query } from "../rpc/define";

/** The user's settings merged with YouTube connection info. Never includes API keys. */
export const get = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return null;
    const [row] = await ctx.db.select().from(settings).where(eq(settings.userId, ctx.userId)).limit(1);
    return settingsDto(row ?? null, ctx.userId, await getChannelSummary(ctx.db, ctx.userId));
  },
});

/**
 * Update the caller's settings. Only the keys in the allow-list are accepted; a key that is
 * absent is left alone, and null / "" clears an optional field. BYOK keys are stored encrypted.
 * One INSERT .. ON CONFLICT so two first-time saves cannot both insert.
 */
export const update = mutation({
  input: settingsUpdateInput,
  handler: async (ctx, args) => {
    const values = buildSettingsValues(args);
    const now = new Date();
    await ctx.db
      .insert(settings)
      .values({
        userId: ctx.userId,
        notificationsEnabled: false,
        // Normalise to an explicit boolean so the settings UI never shows an indeterminate toggle.
        aiAutoGenerate: true,
        ...values,
      })
      .onConflictDoUpdate({
        target: settings.userId,
        set: {
          ...values,
          // Backfill rows that predate the default without clobbering an explicit choice.
          ...(args.aiAutoGenerate === undefined ? { aiAutoGenerate: sql`coalesce(${settings.aiAutoGenerate}, true)` } : {}),
          updatedAt: now,
        },
      });
  },
});

/** Remove the Telegram chat; turns notifications off unless Discord is still connected. */
export const disconnectTelegram = mutation({
  handler: async (ctx) => {
    await ctx.db
      .update(settings)
      .set({
        telegramChatId: null,
        notificationsEnabled: sql`case when ${settings.discordWebhookUrl} is not null then ${settings.notificationsEnabled} else false end`,
        updatedAt: new Date(),
      })
      .where(eq(settings.userId, ctx.userId));
  },
});

export const disconnectDiscord = mutation({
  handler: async (ctx) => {
    await ctx.db.update(settings).set({ discordWebhookUrl: null, updatedAt: new Date() }).where(eq(settings.userId, ctx.userId));
  },
});

const autoPublishKey = (userId: string) => `autoPublish:${userId}`;

/**
 * Turn auto-publish on. Stores the schedule and (re)queues the `autoPublish.run` task for
 * `scheduledAt` (agent C1's handler runs the batch and queues the next run).
 */
export const startAutoPublish = mutation({
  input: startAutoPublishInput,
  handler: async (ctx, args) => {
    assertAutoPublishArgs(args);
    const slots = args.timeSlots?.length ? [...new Set(args.timeSlots)].sort((a, b) => a - b) : null;
    const runAt = new Date(args.scheduledAt);
    const fields = {
      autoPublishEnabled: true,
      autoPublishIntervalMs: args.intervalMs,
      autoPublishCount: args.count,
      autoPublishPrivacy: args.privacy,
      autoPublishNextAt: runAt,
      autoPublishTimeSlots: slots,
      autoPublishTimezoneOffset: args.timezoneOffset ?? null,
    };

    await ctx.db.transaction(async (tx) => {
      await tx
        .insert(settings)
        .values({ userId: ctx.userId, notificationsEnabled: false, ...fields })
        .onConflictDoUpdate({ target: settings.userId, set: { ...fields, updatedAt: new Date() } });
      // Replace any pending run (Convex: scheduler.cancel + scheduler.runAt). A run that is already
      // in flight keeps its lease and queues the next one itself.
      await cancelTask(tx, autoPublishKey(ctx.userId));
      await enqueueTask(tx, { kind: "autoPublish.run", userId: ctx.userId, payload: { userId: ctx.userId }, runAt, dedupeKey: autoPublishKey(ctx.userId) });
    });

    if (runAt.getTime() <= Date.now() + 5_000) kickRunner();
  },
});

export const stopAutoPublish = mutation({
  handler: async (ctx) => {
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(settings)
        .set({ autoPublishEnabled: false, autoPublishNextAt: null, updatedAt: new Date() })
        .where(and(eq(settings.userId, ctx.userId)));
      await cancelTask(tx, autoPublishKey(ctx.userId));
    });
  },
});
