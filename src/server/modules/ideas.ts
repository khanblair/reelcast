// Port of convex/ideas.ts. Every id the client passes is verified against the caller's rows.
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { ideas, videos } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { ideaStatusSchema, tagsSchema, uuidSchema } from "@/server/lib/content/schemas";
import { mutation, query } from "../rpc/define";
import { notFound } from "../rpc/errors";

const IDEAS_LIMIT = 1000;

async function assertOwnsVideo(db: DbLike, userId: string, videoId: string) {
  const [v] = await db.select({ id: videos.id }).from(videos).where(and(eq(videos.id, videoId), eq(videos.userId, userId))).limit(1);
  if (!v) throw notFound("Video not found");
}

/** The user's ideas, newest first, optionally filtered by status. */
export const list = query({
  input: z.object({ status: ideaStatusSchema.optional() }),
  handler: async (ctx, { status }) =>
    ctx.db
      .select()
      .from(ideas)
      .where(and(eq(ideas.userId, ctx.userId), status ? eq(ideas.status, status) : undefined))
      .orderBy(desc(ideas.createdAt))
      .limit(IDEAS_LIMIT),
});

export const create = mutation({
  input: z.object({
    title: z.string().max(500),
    notes: z.string().max(10_000).optional(),
    tags: tagsSchema.optional(),
    scheduledGenerateAt: z.number().positive().optional(),
  }),
  handler: async (ctx, args) => {
    const [row] = await ctx.db
      .insert(ideas)
      .values({
        userId: ctx.userId,
        title: args.title,
        notes: args.notes,
        tags: args.tags,
        status: "concept",
        scheduledGenerateAt: args.scheduledGenerateAt !== undefined ? new Date(args.scheduledGenerateAt) : undefined,
      })
      .returning({ id: ideas.id });
    return row.id;
  },
});

/** Patch only the fields that are provided. */
export const update = mutation({
  input: z.object({
    ideaId: uuidSchema,
    title: z.string().max(500).optional(),
    notes: z.string().max(10_000).optional(),
    tags: tagsSchema.optional(),
    status: ideaStatusSchema.optional(),
    scheduledGenerateAt: z.number().positive().optional(),
    linkedVideoId: uuidSchema.optional(),
  }),
  handler: async (ctx, args) => {
    if (args.linkedVideoId !== undefined) await assertOwnsVideo(ctx.db, ctx.userId, args.linkedVideoId);

    const set: Partial<typeof ideas.$inferInsert> = { updatedAt: new Date() };
    if (args.title !== undefined) set.title = args.title;
    if (args.notes !== undefined) set.notes = args.notes;
    if (args.tags !== undefined) set.tags = args.tags;
    if (args.status !== undefined) set.status = args.status;
    if (args.scheduledGenerateAt !== undefined) set.scheduledGenerateAt = new Date(args.scheduledGenerateAt);
    if (args.linkedVideoId !== undefined) set.linkedVideoId = args.linkedVideoId;

    const rows = await ctx.db
      .update(ideas)
      .set(set)
      .where(and(eq(ideas.id, args.ideaId), eq(ideas.userId, ctx.userId)))
      .returning({ id: ideas.id });
    if (!rows[0]) throw notFound("Idea not found");
  },
});

export const remove = mutation({
  input: z.object({ ideaId: uuidSchema }),
  handler: async (ctx, { ideaId }) => {
    const rows = await ctx.db
      .delete(ideas)
      .where(and(eq(ideas.id, ideaId), eq(ideas.userId, ctx.userId)))
      .returning({ id: ideas.id });
    if (!rows[0]) throw notFound("Idea not found");
  },
});

/** Link an idea to one of the user's videos and move it to "in_production". */
export const linkVideo = mutation({
  input: z.object({ ideaId: uuidSchema, videoId: uuidSchema }),
  handler: async (ctx, { ideaId, videoId }) => {
    await assertOwnsVideo(ctx.db, ctx.userId, videoId);
    const rows = await ctx.db
      .update(ideas)
      .set({ linkedVideoId: videoId, status: "in_production", updatedAt: new Date() })
      .where(and(eq(ideas.id, ideaId), eq(ideas.userId, ctx.userId)))
      .returning({ id: ideas.id });
    if (!rows[0]) throw notFound("Idea not found");
  },
});
