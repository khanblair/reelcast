// Port of convex/aiSessions.ts. Export ONLY rpc definitions from this file.
// `touch` (bump lastMessageAt) had no owner check and was only called by the assistant action:
// it is now touchAiSession in lib/accounts/ai.ts, as is message appending.
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { aiSessions } from "@/db/schema";
import { notFound } from "../rpc/errors";
import { mutation, query } from "../rpc/define";

/** Create a chat session; returns its id. */
export const create = mutation({
  input: z.object({ title: z.string().max(200).optional() }),
  handler: async (ctx, args) => {
    const [row] = await ctx.db
      .insert(aiSessions)
      .values({ userId: ctx.userId, title: args.title?.trim() || null })
      .returning({ id: aiSessions.id });
    return row.id;
  },
});

/** The 30 most recently active sessions. */
export const list = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return [];
    return ctx.db
      .select()
      .from(aiSessions)
      .where(eq(aiSessions.userId, ctx.userId))
      .orderBy(desc(aiSessions.lastMessageAt), desc(aiSessions.createdAt))
      .limit(30);
  },
});

export const updateTitle = mutation({
  input: z.object({ sessionId: z.string().uuid(), title: z.string().max(200) }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .update(aiSessions)
      .set({ title: args.title.trim() || null, lastMessageAt: new Date() })
      .where(and(eq(aiSessions.id, args.sessionId), eq(aiSessions.userId, ctx.userId)))
      .returning({ id: aiSessions.id });
    if (rows.length === 0) throw notFound("Session not found");
  },
});

/** Delete a session and (via ON DELETE CASCADE) all its messages. */
export const remove = mutation({
  input: z.object({ sessionId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .delete(aiSessions)
      .where(and(eq(aiSessions.id, args.sessionId), eq(aiSessions.userId, ctx.userId)))
      .returning({ id: aiSessions.id });
    if (rows.length === 0) throw notFound("Session not found");
  },
});
