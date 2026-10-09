// Port of convex/admin/quota.ts (the internal addQuotaUsage is now src/server/lib/youtubeQuota.ts).
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { users, youtubeQuotaUsage } from "@/db/schema";
import { query } from "../../rpc/define";

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Today's (UTC) quota row for one user, or null if nothing was used. */
export const getTodayQuotaUsage = query({
  auth: "admin",
  input: z.object({ userId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const [row] = await ctx.db
      .select()
      .from(youtubeQuotaUsage)
      .where(and(eq(youtubeQuotaUsage.userId, args.userId), eq(youtubeQuotaUsage.date, todayUtc())))
      .limit(1);
    return row ?? null;
  },
});

/** Every user that consumed YouTube quota today, heaviest first (capped at 500 rows). */
export const getQuotaOverview = query({
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.db
      .select({
        userId: youtubeQuotaUsage.userId,
        email: users.email,
        unitsUsed: youtubeQuotaUsage.unitsUsed,
      })
      .from(youtubeQuotaUsage)
      .leftJoin(users, eq(users.id, youtubeQuotaUsage.userId))
      .where(eq(youtubeQuotaUsage.date, todayUtc()))
      .orderBy(desc(youtubeQuotaUsage.unitsUsed))
      .limit(500);
    return rows.map((r) => ({ ...r, email: r.email ?? "unknown" }));
  },
});
