// Port of convex/admin/usageLedger.ts. Admin-only. One SQL join instead of a per-user loop;
// plan limits come from the single source of truth in src/server/lib/usage.ts.
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { PLANS } from "@/db/schema";
import { PLAN_LIMITS, limitsFor, monthKey, type Plan, type UsageField } from "@/server/lib/usage";
import { query } from "../../rpc/define";

/** Limits at/above this mean "unlimited" (matches the UI's 999999 checks). */
const UNLIMITED = 999_999;

const LEDGER_COL: Record<UsageField, string> = {
  videosUploaded: "coalesce(l.videos_uploaded, 0)",
  metadataGenerated: "coalesce(l.metadata_generated, 0)",
  veoGenerated: "coalesce(l.veo_generated, 0)",
  aiMessagesUsed: "coalesce(l.ai_messages_used, 0)",
};

/**
 * "At limit" = a real cap (> 0 and < unlimited) that has been reached. A limit of 0 means the
 * feature is unavailable on that plan, not "at limit" (the old client check flagged every free
 * user because of the Veo limit of 0). Aliases: u = users, l = usage_ledger; built only from
 * numeric constants.
 */
function atLimitSql(): SQL {
  const branches = (Object.keys(PLAN_LIMITS) as Plan[]).map((plan) => {
    const conds = (Object.keys(LEDGER_COL) as UsageField[])
      .filter((f) => PLAN_LIMITS[plan][f] > 0 && PLAN_LIMITS[plan][f] < UNLIMITED)
      .map((f) => `${LEDGER_COL[f]} >= ${Math.trunc(PLAN_LIMITS[plan][f])}`);
    return `when '${plan}' then ${conds.length ? `(${conds.join(" or ")})` : "false"}`;
  });
  return sql.raw(`(case u.plan ${branches.join(" ")} else false end)`);
}

type OverviewRow = {
  user_id: string;
  email: string;
  name: string | null;
  plan: string;
  videos_uploaded: number;
  metadata_generated: number;
  veo_generated: number;
  ai_messages_used: number;
  at_limit: boolean;
};

/** Current month's usage per user next to their plan limits. Filters run in SQL. */
export const getOverview = query({
  auth: "admin",
  input: z.object({
    limit: z.number().int().min(1).max(1000).optional(),
    plan: z.enum(PLANS).optional(),
    atLimit: z.boolean().optional(),
  }),
  handler: async (ctx, args) => {
    const month = monthKey();
    const rows = (await ctx.db.execute(sql`
      select u.id as user_id, u.email, u.name, u.plan,
             coalesce(l.videos_uploaded, 0) as videos_uploaded,
             coalesce(l.metadata_generated, 0) as metadata_generated,
             coalesce(l.veo_generated, 0) as veo_generated,
             coalesce(l.ai_messages_used, 0) as ai_messages_used,
             ${atLimitSql()} as at_limit
      from users u
      left join usage_ledger l on l.user_id = u.id and l.month = ${month}
      where (${args.plan ?? null}::text is null or u.plan = ${args.plan ?? null})
        and (${args.atLimit ?? false} is false or ${atLimitSql()})
      order by at_limit desc, u.created_at desc
      limit ${args.limit ?? 200}
    `)) as unknown as OverviewRow[];

    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      name: r.name,
      plan: r.plan,
      month,
      videosUploaded: Number(r.videos_uploaded),
      metadataGenerated: Number(r.metadata_generated),
      veoGenerated: Number(r.veo_generated),
      aiMessagesUsed: Number(r.ai_messages_used),
      atLimit: r.at_limit,
      limits: limitsFor(r.plan),
    }));
  },
});

/** Platform-wide counts for the usage page's summary cards (not limited by the table's row cap). */
export const getSummary = query({
  auth: "admin",
  handler: async (ctx) => {
    const rows = (await ctx.db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where u.plan = 'free')::int as free,
             count(*) filter (where u.plan = 'pro')::int as pro,
             count(*) filter (where u.plan = 'elite')::int as elite,
             count(*) filter (where ${atLimitSql()})::int as at_limit
      from users u
      left join usage_ledger l on l.user_id = u.id and l.month = ${monthKey()}
    `)) as unknown as { total: number; free: number; pro: number; elite: number; at_limit: number }[];
    const r = rows[0];
    return { month: monthKey(), total: r.total, free: r.free, pro: r.pro, elite: r.elite, atLimit: r.at_limit };
  },
});
