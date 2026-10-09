// Port of convex/generations.ts (listByUser only; the internal create/update helpers belong to the
// generation job handler).
import { desc, eq } from "drizzle-orm";
import { generations } from "@/db/schema";
import { LIST_LIMIT } from "@/server/lib/content/dto";
import { query } from "../rpc/define";

/** The user's Veo generations, newest first (capped at LIST_LIMIT). */
export const listByUser = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return [];
    return ctx.db
      .select()
      .from(generations)
      .where(eq(generations.userId, ctx.userId))
      .orderBy(desc(generations.createdAt))
      .limit(LIST_LIMIT);
  },
});
