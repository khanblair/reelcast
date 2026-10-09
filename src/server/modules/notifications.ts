// Port of convex/notifications.ts. Export ONLY rpc definitions from this file.
// Creating notifications is server-only: see createNotification in src/server/lib/notifications.ts
// (the Convex `createDummy` mutation was dead code and let a browser write its own notifications).
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { notifications } from "@/db/schema";
import { notFound } from "../rpc/errors";
import { mutation, query } from "../rpc/define";

/** The 50 most recent notifications, newest first. Empty when signed out (the bell mounts before auth settles). */
export const get = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return [];
    return ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, ctx.userId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(50);
  },
});

export const markAsRead = mutation({
  input: z.object({ notificationId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.id, args.notificationId), eq(notifications.userId, ctx.userId)))
      .returning({ id: notifications.id });
    if (rows.length === 0) throw notFound("Notification not found");
  },
});

export const markAllAsRead = mutation({
  handler: async (ctx) => {
    await ctx.db
      .update(notifications)
      .set({ isRead: true })
      .where(and(eq(notifications.userId, ctx.userId), eq(notifications.isRead, false)));
  },
});

export const clearAll = mutation({
  handler: async (ctx) => {
    await ctx.db.delete(notifications).where(eq(notifications.userId, ctx.userId));
  },
});
