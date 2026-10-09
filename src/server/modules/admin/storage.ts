// Port of convex/admin/storage.ts. One grouped SQL query instead of a per-user loop.
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { users, videos } from "@/db/schema";
import { query } from "../../rpc/define";

/** Per-user stored bytes + video count, biggest first. Only users with at least one video. */
export const getPerUserBreakdown = query({
  auth: "admin",
  input: z.object({ limit: z.number().int().min(1).max(2000).optional() }),
  handler: async (ctx, args) => {
    const totalBytes = sql<number>`coalesce(sum(${videos.rawFileSize}), 0)`.mapWith(Number);
    const videoCount = sql<number>`count(*)`.mapWith(Number);
    return ctx.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        plan: users.plan,
        totalBytes,
        videoCount,
      })
      .from(users)
      .innerJoin(videos, eq(videos.userId, users.id))
      .groupBy(users.id)
      .orderBy(desc(totalBytes))
      .limit(args.limit ?? 1000);
  },
});
