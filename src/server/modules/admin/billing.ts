// Admin billing console: subscriptions, payments, and the queue of payments that need a human.
// All functions are admin-only (`auth: "admin"`). Money is never moved from here: flagged payments are
// refunded in the Pesapal dashboard (the confirmation code is shown for that) and then marked reviewed.
import { and, desc, eq, ilike, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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

/**
 * The payment columns an admin list/detail needs, i.e. exactly what `paymentDto` reads. Everything else (the hosted
 * checkout link `redirect_url`, `provider`, `updated_at`, `reviewed_by`) is never fetched, so a 200-row page that is
 * polled every 30 s does not drag them over the wire.
 */
const paymentColumns = {
  id: paymentOrders.id,
  userId: paymentOrders.userId,
  subscriptionId: paymentOrders.subscriptionId,
  merchantRef: paymentOrders.merchantRef,
  orderTrackingId: paymentOrders.orderTrackingId,
  confirmationCode: paymentOrders.confirmationCode,
  purpose: paymentOrders.purpose,
  plan: paymentOrders.plan,
  amount: paymentOrders.amount,
  currency: paymentOrders.currency,
  statusCode: paymentOrders.statusCode,
  statusText: paymentOrders.statusText,
  paymentMethod: paymentOrders.paymentMethod,
  appliedAt: paymentOrders.appliedAt,
  reviewedAt: paymentOrders.reviewedAt,
  reviewNote: paymentOrders.reviewNote,
  createdAt: paymentOrders.createdAt,
};
type PaymentRow = Pick<typeof paymentOrders.$inferSelect, keyof typeof paymentColumns>;

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
function paymentDto(o: PaymentRow, u: { email: string; name: string | null; reviewerEmail: string | null }) {
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
    reviewedByEmail: u.reviewerEmail,
    reviewNote: o.reviewNote,
    createdAt: o.createdAt,
  };
}

const reviewer = alias(users, "reviewer");

/** A payment with its customer and (when reviewed) the admin who reviewed it. */
const paymentUserJoin = {
  order: paymentColumns,
  email: users.email,
  name: users.name,
  reviewerEmail: reviewer.email,
};

// ─── overview ────────────────────────────────────────────────────────────────

export const overview = query({
  auth: "admin",
  handler: async (ctx) => {
    // Polled every 30 s by every open admin tab (the sidebar badge), so two statements instead of four: every number
    // that is a plain count comes back in ONE row (subscriptions by status, plus the two payment counts as scalar
    // subqueries that reuse the exact predicates below); the per-currency revenue is the only multi-row result.
    const [counts, revenue] = await Promise.all([
      ctx.db.execute(sql`
        select count(*) filter (where ${subscriptions.status} = 'active')::int as "active",
               count(*) filter (where ${subscriptions.status} = 'past_due')::int as "pastDue",
               count(*) filter (where ${subscriptions.status} = 'approval_pending')::int as "awaitingPayment",
               count(*) filter (where ${subscriptions.status} = 'cancelled')::int as "cancelled",
               count(*) filter (where ${subscriptions.status} = 'expired')::int as "expired",
               (select count(*) from ${paymentOrders} where ${and(isNull(paymentOrders.reviewedAt), FLAGGED_SQL)})::int as "needsReviewCount",
               (select count(*) from ${paymentOrders} where ${and(or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0)), isNotNull(paymentOrders.orderTrackingId), sql`${paymentOrders.createdAt} > now() - interval '7 days'`)})::int as "pendingPayments"
        from ${subscriptions}
      `) as unknown as Promise<
        { active: number; pastDue: number; awaitingPayment: number; cancelled: number; expired: number; needsReviewCount: number; pendingPayments: number }[]
      >,
      ctx.db
        .select({
          currency: paymentOrders.currency,
          total: sql<string>`coalesce(sum(${paymentOrders.amount}), 0)`,
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(paymentOrders)
        .where(and(eq(paymentOrders.statusCode, 1), isNotNull(paymentOrders.appliedAt), sql`${paymentOrders.appliedAt} > now() - interval '30 days'`))
        .groupBy(paymentOrders.currency),
    ]);

    const c = counts[0];
    return {
      subscriptions: {
        active: c.active,
        pastDue: c.pastDue,
        awaitingPayment: c.awaitingPayment,
        cancelled: c.cancelled,
        expired: c.expired,
      },
      /** Completed, applied payments in the last 30 days, per currency. */
      revenue30d: revenue.map((r) => ({ currency: r.currency, total: Number(r.total), count: r.count })),
      needsReviewCount: c.needsReviewCount,
      /** Orders sent to Pesapal in the last 7 days that have not completed yet. */
      pendingPayments: c.pendingPayments,
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
        .leftJoin(reviewer, eq(reviewer.id, paymentOrders.reviewedBy))
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
        .leftJoin(reviewer, eq(reviewer.id, paymentOrders.reviewedBy))
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
    // One statement: the order (with its customer and reviewer) LEFT JOINed to its notification trail. The trail is every
    // event whose tracking-id OR merchant-ref column holds either of the order's two identifiers (the cross matches are
    // deliberate: they are what the previous two-step lookup did), newest first, at most 50. An order with no events
    // yields a single row whose event is null. Without payloads: what Pesapal told us and what we did.
    const rows = await ctx.db
      .select({
        ...paymentUserJoin,
        event: {
          id: paymentEvents.id,
          notificationType: paymentEvents.notificationType,
          receivedAt: paymentEvents.receivedAt,
          processedAt: paymentEvents.processedAt,
          error: paymentEvents.error,
        },
      })
      .from(paymentOrders)
      .innerJoin(users, eq(users.id, paymentOrders.userId))
      .leftJoin(reviewer, eq(reviewer.id, paymentOrders.reviewedBy))
      .leftJoin(
        paymentEvents,
        or(
          sql`${paymentEvents.orderTrackingId} in (${paymentOrders.orderTrackingId}, ${paymentOrders.merchantRef})`,
          sql`${paymentEvents.merchantRef} in (${paymentOrders.orderTrackingId}, ${paymentOrders.merchantRef})`,
        ),
      )
      .where(eq(paymentOrders.id, args.id))
      .orderBy(desc(paymentEvents.receivedAt))
      .limit(50);
    const row = rows[0];
    if (!row) return null; // the UI shows "not found"; an error would go to the error boundary

    const events = rows.flatMap((r) => (r.event ? [r.event] : []));
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
        .leftJoin(reviewer, eq(reviewer.id, paymentOrders.reviewedBy))
        .where(eq(paymentOrders.userId, args.userId))
        .orderBy(desc(paymentOrders.createdAt))
        .limit(10),
    ]);
    return { subscriptions: subs, payments: pays.map((r) => paymentDto(r.order, r)) };
  },
});
