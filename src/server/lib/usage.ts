/**
 * Plan limits and atomic usage metering. Replaces convex/usageLedger.ts consumeQuotaInMutation.
 *
 * Convex serialized read-check-increment inside one mutation. Postgres (READ COMMITTED) does
 * not, so the increment and the limit check are ONE statement: concurrent callers can never
 * both slip under the limit.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { usageLedger, users } from "@/db/schema";
import { planLimit } from "@/server/rpc/errors";

import { PLAN_LIMITS, PLAN_UPLOAD_LIMIT_BYTES, type Plan, type UsageField } from "@/lib/plan-limits";

// The numbers live in src/lib/plan-limits.ts (shared with the public pricing copy).
export { PLAN_LIMITS, PLAN_UPLOAD_LIMIT_BYTES };
export type { Plan, UsageField };

const COLUMN: Record<UsageField, "videosUploaded" | "metadataGenerated" | "veoGenerated" | "aiMessagesUsed"> = {
  videosUploaded: "videosUploaded",
  metadataGenerated: "metadataGenerated",
  veoGenerated: "veoGenerated",
  aiMessagesUsed: "aiMessagesUsed",
};

/** "YYYY-MM" in UTC. */
export function monthKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function limitsFor(plan: string | null | undefined): Record<UsageField, number> {
  return PLAN_LIMITS[(plan as Plan) in PLAN_LIMITS ? (plan as Plan) : "free"];
}

/**
 * Atomically consume one unit. Throws PLAN_LIMIT_EXCEEDED:<field>:<plan> (the UI parses it)
 * when the user is at their limit. Safe under concurrency.
 *
 * `plan`: pass the caller's plan when the caller already holds it (an rpc handler has `ctx.user.plan`, read fresh
 * on every request) to skip the extra `users` round trip. Job-side callers omit it and the plan is read here.
 */
export async function consumeQuota(db: DbLike, userId: string, field: UsageField, knownPlan?: string | null): Promise<{ used: number; limit: number }> {
  let plan = knownPlan;
  if (!plan) {
    const [u] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1);
    plan = u?.plan ?? "free";
  }
  const limit = limitsFor(plan)[field];
  if (limit <= 0) throw planLimit(`PLAN_LIMIT_EXCEEDED:${field}:${plan}`);

  const col = sql.identifier(COLUMN[field].replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  const rows = (await db.execute(sql`
    insert into usage_ledger (user_id, month, ${col})
    values (${userId}, ${monthKey()}, 1)
    on conflict (user_id, month) do update
      set ${col} = usage_ledger.${col} + 1
      where usage_ledger.${col} < ${limit}
    returning ${col} as used
  `)) as unknown as { used: number }[];

  if (!rows[0]) throw planLimit(`PLAN_LIMIT_EXCEEDED:${field}:${plan}`);
  return { used: rows[0].used, limit };
}

/** Give a unit back (e.g. the work failed before doing anything billable). Never goes below 0. */
export async function refundQuota(db: DbLike, userId: string, field: UsageField): Promise<void> {
  const col = sql.identifier(COLUMN[field].replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  await db.execute(sql`
    update usage_ledger set ${col} = greatest(${col} - 1, 0)
    where user_id = ${userId} and month = ${monthKey()}
  `);
}

export type Usage = {
  plan: string;
  month: string;
  used: Record<UsageField, number>;
  limits: Record<UsageField, number>;
};

/**
 * One statement: the user's plan (and plan source) with this month's ledger row. `users` is the driving table, so a
 * user without a ledger row still gets a row (zeros), and an unknown user gets none (free plan, zeros).
 */
async function readUsage(db: DbLike, userId: string, knownPlan?: string | null): Promise<Usage & { planSource?: string }> {
  const month = monthKey();
  let plan: string;
  let planSource: string | undefined;
  let row: typeof usageLedger.$inferSelect | null | undefined;
  if (knownPlan) {
    // The caller holds the plan: only the ledger is read (and the plan source stays unknown).
    plan = knownPlan;
    [row] = await db
      .select()
      .from(usageLedger)
      .where(and(eq(usageLedger.userId, userId), eq(usageLedger.month, month)))
      .limit(1);
  } else {
    const [r] = await db
      .select({ plan: users.plan, planSource: users.planSource, ledger: usageLedger })
      .from(users)
      .leftJoin(usageLedger, and(eq(usageLedger.userId, users.id), eq(usageLedger.month, month)))
      .where(eq(users.id, userId))
      .limit(1);
    plan = r?.plan ?? "free";
    planSource = r?.planSource ?? "default";
    row = r?.ledger;
  }
  return {
    plan,
    planSource,
    month,
    used: {
      videosUploaded: row?.videosUploaded ?? 0,
      metadataGenerated: row?.metadataGenerated ?? 0,
      veoGenerated: row?.veoGenerated ?? 0,
      aiMessagesUsed: row?.aiMessagesUsed ?? 0,
    },
    limits: limitsFor(plan),
  };
}

/**
 * Current month's usage next to the plan limits (billing page, admin). One statement; with `knownPlan` (the caller
 * already holds a fresh plan) it only reads the ledger.
 */
export async function getUsage(db: DbLike, userId: string, knownPlan?: string | null): Promise<Usage> {
  const { plan, month, used, limits } = await readUsage(db, userId, knownPlan);
  return { plan, month, used, limits };
}

/** getUsage plus `users.plan_source`, still one statement (the billing status needs both). */
export async function getUsageWithPlanSource(db: DbLike, userId: string): Promise<Usage & { planSource: string }> {
  const u = await readUsage(db, userId); // no known plan, so the join path always sets the source
  return { ...u, planSource: u.planSource ?? "default" };
}
