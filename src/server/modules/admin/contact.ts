// Port of convex/admin/contact.ts. EVERY function is admin-only (the Convex version had no auth).
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { contactSubmissions, CONTACT_STATUSES } from "@/db/schema";
import { notFound } from "../../rpc/errors";
import { mutation, query } from "../../rpc/define";

/** Contact form submissions, newest first, optionally filtered by status (filtered in SQL). */
export const listAll = query({
  auth: "admin",
  input: z.object({
    limit: z.number().int().min(1).max(500).optional(),
    status: z.enum(CONTACT_STATUSES).optional(),
  }),
  handler: async (ctx, args) => {
    return ctx.db
      .select()
      .from(contactSubmissions)
      .where(args.status ? eq(contactSubmissions.status, args.status) : undefined)
      .orderBy(desc(contactSubmissions.createdAt))
      .limit(args.limit ?? 100);
  },
});

export const markRead = mutation({
  auth: "admin",
  input: z.object({ submissionId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .update(contactSubmissions)
      .set({ status: "read" })
      .where(eq(contactSubmissions.id, args.submissionId))
      .returning({ id: contactSubmissions.id });
    if (rows.length === 0) throw notFound("Submission not found");
  },
});

export const remove = mutation({
  auth: "admin",
  input: z.object({ submissionId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .delete(contactSubmissions)
      .where(eq(contactSubmissions.id, args.submissionId))
      .returning({ id: contactSubmissions.id });
    if (rows.length === 0) throw notFound("Submission not found");
  },
});
