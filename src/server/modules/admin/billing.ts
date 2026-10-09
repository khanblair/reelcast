// Admin billing console: subscriptions, payments, and the queue of payments that need a human.
// All functions are admin-only (`auth: "admin"`). Money is never moved from here: flagged payments are
// refunded in the Pesapal dashboard (the confirmation code is shown for that) and then marked reviewed.
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { paymentEvents, paymentOrders, subscriptions, SUBSCRIPTION_STATUSES, users } from "@/db/schema";
import { mutation, query } from "../../rpc/define";
import { conflict, notFound } from "../../rpc/errors";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Why a payment needs a human, what happened to the plan, and what to do. */
const FLAGS = {
  amount_mismatch: {
    label: "Amount mismatch",
    guidance:
      "Pesapal reported a different amount or currency than the order, so the plan was not changed. Check the payment in the Pesapal dashboard, then refund it or set the plan manually from the user's page.",
  },
  stale_upgrade: {
    label: "Stale upgrade",
    guidance:
      "The customer paid for an upgrade after their billing period had already moved on, so it was not applied. Refund it in the Pesapal dashboard, or grant the plan manually from the user's page.",
  },
  reversed: {
    label: "Reversed",
    guidance:
      "Pesapal reversed this payment (a chargeback or reversal). The subscription was cancelled automatically and access revoked. Check the customer and the payment in the Pesapal dashboard.",
  },
} as const;
type FlagKey = keyof typeof FLAGS;

type PaymentRow = typeof paymentOrders.$inferSelect;

function flagOf(o: Pick<PaymentRow, "statusText" | "statusCode">): FlagKey | null {
  if (o.statusText === "AMOUNT_MISMATCH") return "amount_mismatch";
  if (o.statusText === "STALE_UPGRADE") return "stale_upgrade";
  if (o.statusCode === 3) return "reversed";
  return null;
}

/** SQL for "this payment is flagged" (kept in step with flagOf and the partial index in the schema). */
const FLAGGED_SQL = sql`(${paymentOrders.statusText} in ('AMOUNT_MISMATCH', 'STALE_UPGRADE') or ${paymentOrders.statusCode} = 3)`;

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);
const emailMatch = (q: string | undefined) => (q?.trim() ? ilike(users.email, `%${escapeLike(q.trim())}%`) : undefined);

const paging = {
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
};

/** What an admin sees about a payment. No checkout links, no raw provider payloads. */
function paymentDto(o: PaymentRow, u: { email: string; name: string | null }) {
  const flag = flagOf(o);
  return {
    id: o.id,
    userId: o.userId,
    email: u.email,
    name: u.name,
    subscriptionId: o.subscriptionId,
    merchantRef: o.merchantRef,
    orderTrackingId: o.orderTrackingId,
    confirmationCode: o.confirmationCode,
    purpose: o.purpose,
    plan: o.plan,
    amount: Number(o.amount),
    currency: o.currency,
    statusCode: o.statusCode,
    statusText: o.statusText,
    paymentMethod: o.paymentMethod,
    appliedAt: o.appliedAt,
    flag,
    flagLabel: flag ? FLAGS[flag].label : null,
    guidance: flag ? FLAGS[flag].guidance : null,
    reviewedAt: o.reviewedAt,
    reviewNote: o.reviewNote,
    createdAt: o.createdAt,
  };
}

const paymentUserJoin = {
  order: paymentOrders,
  email: users.email,
  name: users.name,
};

// ─── overview ────────────────────────────────────────────────────────────────

export const overview = query({
  auth: "admin",
  handler: async (ctx) => {
    const [subs, revenue, review, pending] = await Promise.all([
      ctx.db
        .select({ status: subscriptions.status, n: sql<number>`count(*)`.mapWith(Number) })
        .from(subscriptions)
        .groupBy(subscriptions.status),
      ctx.db
        .select({
          currency: paymentOrders.currency,
          total: sql<string>`coalesce(sum(${paymentOrders.amount}), 0)`,
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(paymentOrders)
        .where(and(eq(paymentOrders.statusCode, 1), isNotNull(paymentOrders.appliedAt), sql`${paymentOrders.appliedAt} > now() - interval '30 days'`))
        .groupBy(paymentOrders.currency),
      ctx.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(paymentOrders)
        .where(and(isNull(paymentOrders.reviewedAt), FLAGGED_SQL)),
      ctx.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(paymentOrders)
        .where(and(or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0)), isNotNull(paymentOrders.orderTrackingId), sql`${paymentOrders.createdAt} > now() - interval '7 days'`)),
    ]);

    const byStatus = Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, subs.find((r) => r.status === s)?.n ?? 0])) as Record<(typeof SUBSCRIPTION_STATUSES)[number], number>;
    return {
      subscriptions: {
        active: byStatus.active,
        pastDue: byStatus.past_due,
        awaitingPayment: byStatus.approval_pending,
        cancelled: byStatus.cancelled,
        expired: byStatus.expired,
      },
      /** Completed, applied payments in the last 30 days, per currency. */
      revenue30d: revenue.map((r) => ({ currency: r.currency, total: Number(r.total), count: r.count })),
      needsReviewCount: review[0]?.n ?? 0,
      /** Orders sent to Pesapal in the last 7 days that have not completed yet. */
      pendingPayments: pending[0]?.n ?? 0,
    };
  },
});

// ─── subscriptions ───────────────────────────────────────────────────────────

export const listSubscriptions = query({
  auth: "admin",
  input: z.object({ status: z.enum(SUBSCRIPTION_STATUSES).optional(), search: z.string().max(100).optional(), ...paging }),
  handler: async (ctx, args) => {
    const where = and(args.status ? eq(subscriptions.status, args.status) : undefined, emailMatch(args.search));
    const [rows, total] = await Promise.all([
      ctx.db
        .select({
          id: subscriptions.id,
          userId: subscriptions.userId,
          email: users.email,
          name: users.name,
          userPlan: users.plan,
          planSource: users.planSource,
          plan: subscriptions.plan,
          status: subscriptions.status,
          periodStart: subscriptions.periodStart,
          periodEnd: subscriptions.periodEnd,
          graceUntil: subscriptions.graceUntil,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          pendingPlan: subscriptions.pendingPlan,
          createdAt: subscriptions.createdAt,
        })
        .from(subscriptions)
        .innerJoin(users, eq(users.id, subscriptions.userId))
        .where(where)
        .orderBy(desc(subscriptions.createdAt))
        .limit(args.limit)
        .offset(args.offset),
      ctx.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(subscriptions).innerJoin(users, eq(users.id, subscriptions.userId)).where(where),
    ]);
    return { total: total[0]?.n ?? 0, rows };
  },
});

// ─── payments ────────────────────────────────────────────────────────────────

const PAYMENT_FILTERS = ["all", "completed", "pending", "failed", "reversed"] as const;

function paymentFilterSql(filter: (typeof PAYMENT_FILTERS)[number]): SQL | undefined {
  switch (filter) {
    case "completed":
      return eq(paymentOrders.statusCode, 1);
    case "failed":
      return eq(paymentOrders.statusCode, 2);
    case "reversed":
      return eq(paymentOrders.statusCode, 3);
    case "pending":
      return or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0));
    default:
      return undefined;
  }
}

export const listPayments = query({
  auth: "admin",
  input: z.object({ filter: z.enum(PAYMENT_FILTERS).default("all"), search: z.string().max(100).optional(), ...paging }),
  handler: async (ctx, args) => {
    const where = and(paymentFilterSql(args.filter), emailMatch(args.search));
    const [rows, total] = await Promise.all([
      ctx.db
        .select(paymentUserJoin)
        .from(paymentOrders)
        .innerJoin(users, eq(users.id, paymentOrders.userId))
        .where(where)
        .orderBy(desc(paymentOrders.createdAt))
        .limit(args.limit)
        .offset(args.offset),
      ctx.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(paymentOrders).innerJoin(users, eq(users.id, paymentOrders.userId)).where(where),
    ]);
    return { total: total[0]?.n ?? 0, rows: rows.map((r) => paymentDto(r.order, r)) };
  },
});

// ─── needs review ────────────────────────────────────────────────────────────

/** Flagged payments: unreviewed by default, or everything flagged with `includeReviewed`. */
export const listNeedsReview = query({
  auth: "admin",
  input: z.object({ includeReviewed: z.boolean().default(false), limit: paging.limit, offset: paging.offset }),
  handler: async (ctx, args) => {
    const where = and(FLAGGED_SQL, args.includeReviewed ? undefined : isNull(paymentOrders.reviewedAt));
    const [rows, total] = await Promise.all([
      ctx.db
        .select(paymentUserJoin)
        .from(paymentOrders)
        .innerJoin(users, eq(users.id, paymentOrders.userId))
        .where(where)
        .orderBy(desc(paymentOrders.createdAt))
        .limit(args.limit)
        .offset(args.offset),
      ctx.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(paymentOrders).where(where),
    ]);
    return { total: total[0]?.n ?? 0, rows: rows.map((r) => paymentDto(r.order, r)) };
  },
});

/** Mark a flagged payment as dealt with. Idempotent for the caller: a second call is a CONFLICT, not a rewrite. */
export const markReviewed = mutation({
  auth: "admin",
  input: z.object({ id: z.string().uuid(), note: z.string().trim().max(500).optional() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .update(paymentOrders)
      .set({ reviewedAt: new Date(), reviewedBy: ctx.userId, reviewNote: args.note || null, updatedAt: new Date() })
      .where(and(eq(paymentOrders.id, args.id), isNull(paymentOrders.reviewedAt), FLAGGED_SQL))
      .returning({ id: paymentOrders.id });
    if (rows[0]) return;

    // Nothing updated: tell "doesn't exist / isn't flagged" apart from "already reviewed".
    const [existing] = await ctx.db.select({ reviewedAt: paymentOrders.reviewedAt, statusText: paymentOrders.statusText, statusCode: paymentOrders.statusCode }).from(paymentOrders).where(eq(paymentOrders.id, args.id)).limit(1);
    if (!existing || !flagOf(existing)) throw notFound("That payment isn't flagged for review.");
    throw conflict("This payment was already marked as reviewed.");
  },
});

// ─── one payment, with its notification trail ────────────────────────────────

export const getPayment = query({
  auth: "admin",
  input: z.object({ id: z.string().uuid() }),
  handler: async (ctx, args) => {
    const [row] = await ctx.db
      .select(paymentUserJoin)
      .from(paymentOrders)
      .innerJoin(users, eq(users.id, paymentOrders.userId))
      .where(eq(paymentOrders.id, args.id))
      .limit(1);
    if (!row) throw notFound("Payment not found");

    // Notification trail (what Pesapal told us and what we did), without the raw payloads.
    const keys = [row.order.orderTrackingId, row.order.merchantRef].filter((k): k is string => !!k);
    const events = keys.length
      ? await ctx.db
          .select({
            id: paymentEvents.id,
            notificationType: paymentEvents.notificationType,
            receivedAt: paymentEvents.receivedAt,
            processedAt: paymentEvents.processedAt,
            error: paymentEvents.error,
          })
          .from(paymentEvents)
          .where(or(inArray(paymentEvents.orderTrackingId, keys), inArray(paymentEvents.merchantRef, keys)))
          .orderBy(desc(paymentEvents.receivedAt))
          .limit(50)
      : [];
    return { payment: paymentDto(row.order, row), events };
  },
});

// ─── per user (user detail page) ─────────────────────────────────────────────

export const forUser = query({
  auth: "admin",
  input: z.object({ userId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const [subs, pays] = await Promise.all([
      ctx.db
        .select({
          id: subscriptions.id,
          plan: subscriptions.plan,
          status: subscriptions.status,
          periodStart: subscriptions.periodStart,
          periodEnd: subscriptions.periodEnd,
          graceUntil: subscriptions.graceUntil,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          pendingPlan: subscriptions.pendingPlan,
          createdAt: subscriptions.createdAt,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, args.userId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(5),
      ctx.db
        .select(paymentUserJoin)
        .from(paymentOrders)
        .innerJoin(users, eq(users.id, paymentOrders.userId))
        .where(eq(paymentOrders.userId, args.userId))
        .orderBy(desc(paymentOrders.createdAt))
        .limit(10),
    ]);
    return { subscriptions: subs, payments: pays.map((r) => paymentDto(r.order, r)) };
  },
});
