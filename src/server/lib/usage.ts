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
 */
export async function consumeQuota(db: DbLike, userId: string, field: UsageField): Promise<{ used: number; limit: number }> {
  const [u] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1);
  const plan = u?.plan ?? "free";
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

/** Current month's usage next to the plan limits (billing page, admin). */
export async function getUsage(db: DbLike, userId: string) {
  const [u] = await db.select({ plan: users.plan }).from(users).where(eq(users.id, userId)).limit(1);
  const [row] = await db
    .select()
    .from(usageLedger)
    .where(and(eq(usageLedger.userId, userId), eq(usageLedger.month, monthKey())))
    .limit(1);
  const plan = u?.plan ?? "free";
  const limits = limitsFor(plan);
  return {
    plan,
    month: monthKey(),
    used: {
      videosUploaded: row?.videosUploaded ?? 0,
      metadataGenerated: row?.metadataGenerated ?? 0,
      veoGenerated: row?.veoGenerated ?? 0,
      aiMessagesUsed: row?.aiMessagesUsed ?? 0,
    },
    limits,
  };
}
