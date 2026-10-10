/**
 * Provider-agnostic billing core: subscriptions, payment orders, entitlement.
 *
 * Model
 *  - Reelcast owns renewals. Every charge is a one-off hosted-checkout order; a paid order buys one
 *    30-day period. We do NOT use Pesapal's own recurring feature (card-only, customer controlled).
 *  - A COMPLETED payment is applied exactly once: the order row is locked FOR UPDATE and flipped with
 *    `UPDATE payment_orders SET applied_at = now WHERE id = $1 AND applied_at IS NULL` in the same
 *    transaction as the entitlement change.
 *  - Nothing here trusts a callback / IPN query string. `applyVerifiedPayment` only accepts a
 *    `VerifiedStatus` the caller fetched from the provider API, and re-checks the merchant reference,
 *    amount and currency against the stored order.
 *  - users.plan_source = 'admin' is never overwritten. A lapse only downgrades users whose plan_source
 *    is 'subscription'.
 *  - No transaction is held across a provider call: orders are inserted + committed, THEN submitted.
 *
 * merchant_ref formats (Pesapal: <= 50 chars, [A-Za-z0-9-_.:], unique forever, so a failed or
 * abandoned order is never re-submitted; a retry always gets a new row):
 *   initial  in_<subId hex32>_<rand6>                      42 chars
 *   renewal  rn_<subId hex32>_<periodEnd epoch s>[_<k>]    46 (+2) chars   one per period, deterministic
 *   upgrade  up_<subId hex32>_<periodEnd epoch s>_<rand3>  50 chars        anchored to the period it was priced for
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, like, lte, ne, notExists, notInArray, or, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { PAYMENT_PURPOSES, paymentEvents, paymentOrders, subscriptions, users } from "@/db/schema";
import { createNotification } from "@/server/lib/notifications";
import { badRequest, conflict, notFound } from "@/server/rpc/errors";
import {
  GRACE_DAYS,
  MIN_UPGRADE_CHARGE_CENTS,
  PLAN_NAMES,
  RENEWAL_LEAD_MS,
  addPeriod,
  centsToDecimal,
  isPaidPlan,
  planRank,
  prorateUpgradeCents,
  toCents,
  DAY_MS,
  type PaidPlan,
  type PlanKey,
  type PlanPrices,
} from "./plans";
import { BillingConfigError, type PaymentProvider, type VerifiedStatus } from "./types";

export type SubRow = typeof subscriptions.$inferSelect;
export type OrderRow = typeof paymentOrders.$inferSelect;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const LIVE_STATUSES = ["approval_pending", "active", "past_due"] as const;

export type BillingDeps = {
  provider: PaymentProvider;
  prices: PlanPrices;
  currency: string;
  /** Public origin without a trailing slash, e.g. https://reelcast.app */
  appUrl: string;
  now?: () => Date;
};

const clock = (deps?: { now?: () => Date }): Date => deps?.now?.() ?? new Date();

/** A hosted checkout is reused (not re-created) for this long. */
export const CHECKOUT_REUSE_TTL_MS = 30 * 60_000;
/** An in-flight submission older than this is considered crashed. */
const SUBMIT_LEASE_MS = 2 * 60_000;
/** approval_pending subscriptions with no payment are dropped after this long. */
const STALE_PENDING_MS = 7 * DAY_MS;
/** Reconcile gives up polling an unpaid order after this long (an IPN can still settle it later). */
const RECONCILE_GIVE_UP_MS = 3 * DAY_MS;
const RECONCILE_MIN_AGE_MS = 10 * 60_000;

/** status_text values that mean "this order row can never become a live checkout". */
const DEAD_TEXTS = ["submit_failed", "submit_abandoned", "superseded", "ABANDONED"];

// ─── merchant references ─────────────────────────────────────────────────────

const hex32 = (id: string) => id.replace(/-/g, "").toLowerCase();
const rand = (n: number) => randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
const epochSec = (d: Date) => Math.floor(d.getTime() / 1000);

export const renewalBaseRef = (subId: string, periodEnd: Date) => `rn_${hex32(subId)}_${epochSec(periodEnd)}`;
const upgradePrefix = (subId: string, periodEnd: Date) => `up_${hex32(subId)}_${epochSec(periodEnd)}_`;
const initialPrefix = (subId: string) => `in_${hex32(subId)}_`;

function* renewalRefs(base: string): Generator<string> {
  yield base;
  for (let k = 1; k <= 9; k++) yield `${base}_${k}`;
}
function* randomRefs(prefix: string, n: number, tries: number): Generator<string> {
  for (let i = 0; i < tries; i++) yield `${prefix}${rand(n)}`;
}

/** The period_end (epoch seconds) an upgrade order was priced against, or null if the ref is not an upgrade ref. */
export function parseUpgradeAnchor(ref: string): number | null {
  const m = /^up_[0-9a-f]{32}_(\d{9,11})_[0-9a-f]{3}$/.exec(ref);
  return m ? Number(m[1]) : null;
}

// ─── small helpers ───────────────────────────────────────────────────────────

const fmtDate = (d: Date | null | undefined) =>
  d ? d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "";

/** The plan the NEXT payment is for: a scheduled plan change (never "free", that is a cancel) or the current plan. */
export function renewalPlan(sub: Pick<SubRow, "plan" | "pendingPlan">): PaidPlan {
  return sub.pendingPlan && isPaidPlan(sub.pendingPlan) ? sub.pendingPlan : sub.plan;
}

const isPendingDowngrade = (sub: Pick<SubRow, "plan" | "pendingPlan">) => planRank(renewalPlan(sub)) < planRank(sub.plan);

type UserRow = typeof users.$inferSelect;

async function loadUser(db: DbLike, userId: string): Promise<UserRow> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw notFound("User not found");
  return u;
}

/** Admin-granted plans are managed by admins; a payment could not change them, so do not take money. */
function assertSelfServe(user: UserRow): void {
  if (user.planSource === "admin") throw badRequest("Your plan is managed by an administrator, so it can't be changed from here.");
}

async function lockLiveSub(tx: DbLike, userId: string): Promise<SubRow | null> {
  const [s] = await tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, [...LIVE_STATUSES])))
    .for("update")
    .limit(1);
  return s ?? null;
}

async function safeNotify(
  db: DbLike,
  n: { userId: string; title: string; message: string; type: "info" | "success" | "warning" | "error" },
): Promise<void> {
  try {
    await createNotification(db, { ...n, link: "/billing" });
  } catch (e) {
    console.error("[billing] could not create notification", e instanceof Error ? e.message : e);
  }
}

async function logEvent(
  tx: DbLike,
  e: { orderTrackingId?: string | null; merchantRef?: string | null; type: string; payload: Record<string, unknown>; error?: string | null; now: Date },
): Promise<void> {
  await tx.insert(paymentEvents).values({
    provider: "pesapal",
    orderTrackingId: e.orderTrackingId ?? null,
    merchantRef: e.merchantRef ?? null,
    notificationType: e.type,
    payload: e.payload,
    receivedAt: e.now,
    processedAt: e.now,
    error: e.error ?? null,
  });
}

// ─── entitlement ─────────────────────────────────────────────────────────────

/** Sets users.plan from a subscription. Never touches plan_source = 'admin'. Returns whether the row changed. */
async function grantEntitlement(tx: DbLike, userId: string, plan: PaidPlan, now: Date): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ plan, planSource: "subscription", updatedAt: now })
    .where(and(eq(users.id, userId), ne(users.planSource, "admin")))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Back to free, but ONLY for users whose plan came from a subscription, and only when no other
 * live paid subscription still backs the plan. One statement for any number of users.
 */
async function revokeEntitlements(tx: DbLike, userIds: string[], now: Date): Promise<void> {
  if (userIds.length === 0) return;
  await tx
    .update(users)
    .set({ plan: "free", planSource: "default", updatedAt: now })
    .where(
      and(
        inArray(users.id, userIds),
        eq(users.planSource, "subscription"),
        sql`not exists (select 1 from subscriptions s where s.user_id = ${users.id} and s.status in ('active', 'past_due'))`,
      ),
    );
}

const revokeEntitlement = (tx: DbLike, userId: string, now: Date) => revokeEntitlements(tx, [userId], now);

// ─── checkout ────────────────────────────────────────────────────────────────

export type CheckoutResult = { orderId: string; redirectUrl: string };

type Prepared = { kind: "reuse"; order: OrderRow } | { kind: "submit"; order: OrderRow; supersede: OrderRow | null };

async function insertOrder(
  tx: DbLike,
  refs: Iterable<string>,
  values: Omit<typeof paymentOrders.$inferInsert, "merchantRef">,
): Promise<OrderRow | null> {
  for (const ref of refs) {
    const [row] = await tx
      .insert(paymentOrders)
      .values({ ...values, merchantRef: ref })
      .onConflictDoNothing({ target: paymentOrders.merchantRef })
      .returning();
    if (row) return row;
  }
  return null;
}

/** Quote for an immediate upgrade; `cents` below MIN_UPGRADE_CHARGE_CENTS means "schedule it instead". */
export function quoteUpgrade(sub: SubRow, target: PaidPlan, deps: Pick<BillingDeps, "prices">, now: Date): { cents: number } {
  const oldPrice = deps.prices[sub.plan];
  const newPrice = deps.prices[target];
  if (oldPrice == null || newPrice == null || !sub.periodEnd) throw badRequest("This plan change isn't available right now.");
  return { cents: prorateUpgradeCents({ oldPrice, newPrice, periodEnd: sub.periodEnd, now }) };
}

/**
 * Open (or re-open) a hosted checkout for `plan`.
 *  initial  no live subscription (or an unpaid approval_pending one): creates/reuses the subscription row.
 *  renewal  active/past_due subscription, inside the renewal window: pays the next 30 days.
 *  upgrade  active subscription moving to a higher plan: pays the prorated difference now.
 * Concurrent calls serialize on the subscription row; a still-valid hosted checkout is returned as is.
 */
export async function createCheckout(
  db: DbLike,
  input: { userId: string; plan: PaidPlan; purpose: PaymentPurpose },
  deps: BillingDeps,
): Promise<CheckoutResult> {
  const now = clock(deps);
  const { userId, plan, purpose } = input;
  const price = deps.prices[plan];
  if (price == null) throw badRequest(`${PLAN_NAMES[plan]} isn't available for purchase.`);
  const user = await loadUser(db, userId);
  assertSelfServe(user);

  const prepared = await db.transaction(async (tx): Promise<Prepared> => {
    let sub = await lockLiveSub(tx, userId);
    let amountCents = toCents(price);
    let pattern: string;
    let refs: Iterable<string>;

    if (purpose === "initial") {
      if (sub && sub.status !== "approval_pending") throw conflict("You already have a subscription. Use change plan to switch plans.");
      if (!sub) {
        const [created] = await tx.insert(subscriptions).values({ userId, plan, status: "approval_pending" }).onConflictDoNothing().returning();
        sub = created ?? (await lockLiveSub(tx, userId));
        if (!sub || sub.status !== "approval_pending") throw conflict("You already have a subscription. Use change plan to switch plans.");
      } else if (sub.plan !== plan) {
        [sub] = await tx.update(subscriptions).set({ plan, updatedAt: now }).where(eq(subscriptions.id, sub.id)).returning();
      }
      pattern = `${initialPrefix(sub.id)}%`;
      refs = randomRefs(initialPrefix(sub.id), 6, 5);
    } else if (purpose === "renewal") {
      if (!sub || (sub.status !== "active" && sub.status !== "past_due") || !sub.periodEnd) throw badRequest("You don't have a subscription to renew.");
      const wanted = renewalPlan(sub);
      if (plan !== wanted) throw badRequest(`Your next payment is for the ${PLAN_NAMES[wanted]} plan. Use change plan to switch.`);
      const msLeft = sub.periodEnd.getTime() - now.getTime();
      if (sub.status === "active" && msLeft > RENEWAL_LEAD_MS) {
        throw badRequest(`Renewal opens on ${fmtDate(new Date(sub.periodEnd.getTime() - RENEWAL_LEAD_MS))}.`);
      }
      if (sub.status === "active" && msLeft > 0 && isPendingDowngrade(sub)) {
        throw badRequest(`Your switch to ${PLAN_NAMES[wanted]} starts when the current period ends on ${fmtDate(sub.periodEnd)}. You can pay then.`);
      }
      const base = renewalBaseRef(sub.id, sub.periodEnd);
      pattern = `${base}%`;
      refs = renewalRefs(base);
    } else {
      if (!sub || sub.status !== "active" || !sub.periodEnd || sub.periodEnd <= now) throw badRequest("You can only upgrade an active subscription.");
      if (planRank(plan) <= planRank(sub.plan)) throw badRequest("Pick a higher plan to upgrade.");
      amountCents = quoteUpgrade(sub, plan, deps, now).cents;
      if (amountCents < MIN_UPGRADE_CHARGE_CENTS) throw badRequest("The upgrade amount is too small to charge now. Schedule the change for your next renewal instead.");
      pattern = `${upgradePrefix(sub.id, sub.periodEnd)}%`;
      refs = randomRefs(upgradePrefix(sub.id, sub.periodEnd), 3, 8);
    }

    // Reuse a live hosted checkout, claim a never-submitted row, or mark broken ones dead.
    const candidates = await tx
      .select()
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.subscriptionId, sub.id),
          eq(paymentOrders.purpose, purpose),
          eq(paymentOrders.plan, plan),
          isNull(paymentOrders.appliedAt),
          or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0)),
          like(paymentOrders.merchantRef, pattern),
          or(isNull(paymentOrders.statusText), notInArray(paymentOrders.statusText, DEAD_TEXTS)),
        ),
      )
      .orderBy(desc(paymentOrders.createdAt))
      .for("update");

    let supersede: OrderRow | null = null;
    for (const o of candidates) {
      // Priced differently (the price changed): ignore. Upgrade quotes drift with time, so they are exempt.
      if (o.currency !== deps.currency || (purpose !== "upgrade" && toCents(o.amount) !== amountCents)) continue;
      if (o.statusText === "submitting") {
        if (now.getTime() - o.updatedAt.getTime() < SUBMIT_LEASE_MS) throw conflict("Your checkout is being prepared. Please try again in a few seconds.");
        await tx.update(paymentOrders).set({ statusCode: 2, statusText: "submit_abandoned", updatedAt: now }).where(eq(paymentOrders.id, o.id));
        continue;
      }
      if (o.orderTrackingId) {
        if (o.redirectUrl && now.getTime() - o.createdAt.getTime() < CHECKOUT_REUSE_TTL_MS) return { kind: "reuse", order: o };
        supersede = supersede ?? o;
        continue;
      }
      const [claimed] = await tx
        .update(paymentOrders)
        .set({ statusText: "submitting", updatedAt: now })
        .where(and(eq(paymentOrders.id, o.id), isNull(paymentOrders.orderTrackingId), isNull(paymentOrders.statusText)))
        .returning();
      if (claimed) return { kind: "submit", order: claimed, supersede };
    }

    const created = await insertOrder(tx, refs, {
      userId,
      subscriptionId: sub.id,
      provider: "pesapal",
      purpose,
      plan,
      amount: centsToDecimal(amountCents),
      currency: deps.currency,
      statusText: "submitting",
    });
    if (!created) throw conflict("Could not create a checkout. Please try again.");
    return { kind: "submit", order: created, supersede };
  });

  if (prepared.kind === "reuse") return { orderId: prepared.order.id, redirectUrl: prepared.order.redirectUrl as string };

  const result = await submitOrderRow(db, prepared.order, user, deps);
  if (prepared.supersede?.orderTrackingId) {
    const old = prepared.supersede;
    await db
      .update(paymentOrders)
      .set({ statusText: "superseded", updatedAt: new Date() })
      .where(and(eq(paymentOrders.id, old.id), isNull(paymentOrders.appliedAt), or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0))));
    deps.provider.cancelOrder(old.orderTrackingId as string).catch(() => undefined); // best effort
  }
  return result;
}

function describeOrder(order: OrderRow): string {
  const name = PLAN_NAMES[order.plan];
  return order.purpose === "upgrade" ? `Reelcast ${name} upgrade (prorated)` : `Reelcast ${name} plan - 30 days`;
}

async function submitOrderRow(db: DbLike, order: OrderRow, user: UserRow, deps: BillingDeps): Promise<CheckoutResult> {
  const [first, ...rest] = (user.name ?? "").trim().split(/\s+/).filter(Boolean);
  let res;
  try {
    res = await deps.provider.submitOrder({
      merchantRef: order.merchantRef,
      amount: Number(order.amount),
      currency: order.currency,
      description: describeOrder(order),
      callbackUrl: `${deps.appUrl}/api/billing/callback`,
      cancellationUrl: `${deps.appUrl}/billing?status=cancelled`,
      buyer: { email: user.email, firstName: first, lastName: rest.length ? rest.join(" ") : undefined },
    });
  } catch (e) {
    if (e instanceof BillingConfigError) {
      // Nothing was sent to the provider: release the lease so the row stays usable.
      await db.update(paymentOrders).set({ statusText: null, updatedAt: new Date() }).where(eq(paymentOrders.id, order.id));
      throw badRequest(e.message);
    }
    // We cannot know whether the provider created the order: never re-submit this reference.
    await db.update(paymentOrders).set({ statusCode: 2, statusText: "submit_failed", updatedAt: new Date() }).where(eq(paymentOrders.id, order.id));
    console.error("[billing] order submission failed", order.merchantRef, e instanceof Error ? e.message : "unknown error");
    throw badRequest("We couldn't open the payment page. Please try again in a moment.");
  }
  const [saved] = await db
    .update(paymentOrders)
    .set({ orderTrackingId: res.orderTrackingId, redirectUrl: res.redirectUrl, statusText: null, updatedAt: new Date() })
    .where(and(eq(paymentOrders.id, order.id), isNull(paymentOrders.orderTrackingId)))
    .returning({ id: paymentOrders.id });
  if (!saved) throw new Error(`Could not save the checkout for order ${order.merchantRef}`);
  return { orderId: saved.id, redirectUrl: res.redirectUrl };
}

/** Initial checkout for users without a live subscription, renewal for the current plan; anything else belongs to changePlan. */
export async function checkoutForUser(db: DbLike, input: { userId: string; plan: PaidPlan }, deps: BillingDeps): Promise<CheckoutResult> {
  const [live] = await db
    .select({ status: subscriptions.status })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, input.userId), inArray(subscriptions.status, [...LIVE_STATUSES])))
    .limit(1);
  const purpose: PaymentPurpose = live && live.status !== "approval_pending" ? "renewal" : "initial";
  return createCheckout(db, { userId: input.userId, plan: input.plan, purpose }, deps);
}

// ─── cancel / change plan ────────────────────────────────────────────────────

/** Stop renewing: access continues until period_end. No external call (we own renewals). Idempotent. */
export async function cancelAtPeriodEnd(db: DbLike, userId: string, now = new Date()): Promise<{ endsAt: Date | null }> {
  return db.transaction(async (tx) => {
    const sub = await lockLiveSub(tx, userId);
    if (!sub) throw notFound("You don't have a subscription to cancel.");
    if (sub.status === "approval_pending") {
      await tx.update(subscriptions).set({ status: "cancelled", updatedAt: now }).where(eq(subscriptions.id, sub.id));
      return { endsAt: null };
    }
    await tx.update(subscriptions).set({ cancelAtPeriodEnd: true, pendingPlan: null, updatedAt: now }).where(eq(subscriptions.id, sub.id));
    return { endsAt: sub.status === "past_due" ? (sub.graceUntil ?? sub.periodEnd) : sub.periodEnd };
  });
}

/** Undo a cancellation while the paid period (or grace) is still running. */
export async function resumeSubscription(db: DbLike, userId: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const sub = await lockLiveSub(tx, userId);
    if (!sub || sub.status === "approval_pending") throw notFound("You don't have a subscription to resume.");
    await tx.update(subscriptions).set({ cancelAtPeriodEnd: false, updatedAt: now }).where(eq(subscriptions.id, sub.id));
  });
}

export type ChangePlanResult =
  | { outcome: "checkout"; orderId: string; redirectUrl: string }
  | { outcome: "scheduled"; plan: PlanKey; effectiveAt: Date | null }
  | { outcome: "unchanged" };

type ChangeDecision =
  | { kind: "none" }
  | { kind: "scheduled"; plan: PlanKey; effectiveAt: Date | null }
  | { kind: "checkout"; purpose: PaymentPurpose; plan: PaidPlan };

/**
 * Switch plans.
 *  upgrade   -> pay the prorated difference now (new order); falls back to "next renewal" when the amount is negligible
 *  downgrade -> pending_plan, applied by the next renewal payment
 *  free      -> same as cancelling at period end
 */
export async function changePlan(db: DbLike, input: { userId: string; plan: PlanKey }, deps: BillingDeps): Promise<ChangePlanResult> {
  const now = clock(deps);
  const { userId, plan: target } = input;
  const user = await loadUser(db, userId);
  assertSelfServe(user);
  if (isPaidPlan(target) && deps.prices[target] == null) throw badRequest(`${PLAN_NAMES[target]} isn't available for purchase.`);

  const decision = await db.transaction(async (tx): Promise<ChangeDecision> => {
    const sub = await lockLiveSub(tx, userId);
    if (!sub || sub.status === "approval_pending") {
      return isPaidPlan(target) ? { kind: "checkout", purpose: "initial", plan: target } : { kind: "none" };
    }
    const setSub = (patch: Partial<typeof subscriptions.$inferInsert>) =>
      tx.update(subscriptions).set({ ...patch, updatedAt: now }).where(eq(subscriptions.id, sub.id));

    if (target === "free") {
      await setSub({ cancelAtPeriodEnd: true, pendingPlan: null });
      return { kind: "scheduled", plan: "free", effectiveAt: sub.status === "past_due" ? (sub.graceUntil ?? sub.periodEnd) : sub.periodEnd };
    }
    if (sub.status === "past_due") {
      // Already lapsed: the next payment simply happens at the plan the user picks.
      await setSub({ pendingPlan: target === sub.plan ? null : target, cancelAtPeriodEnd: false });
      return { kind: "checkout", purpose: "renewal", plan: target };
    }
    if (target === sub.plan) {
      if (sub.pendingPlan) {
        await setSub({ pendingPlan: null });
        return { kind: "scheduled", plan: target, effectiveAt: null };
      }
      return { kind: "none" };
    }
    if (planRank(target) < planRank(sub.plan)) {
      await setSub({ pendingPlan: target });
      return { kind: "scheduled", plan: target, effectiveAt: sub.periodEnd };
    }
    // Upgrade.
    if (quoteUpgrade(sub, target, deps, now).cents < MIN_UPGRADE_CHARGE_CENTS) {
      await setSub({ pendingPlan: target });
      return { kind: "scheduled", plan: target, effectiveAt: sub.periodEnd };
    }
    await setSub({ pendingPlan: null });
    return { kind: "checkout", purpose: "upgrade", plan: target };
  });

  if (decision.kind === "none") return { outcome: "unchanged" };
  if (decision.kind === "scheduled") return { outcome: "scheduled", plan: decision.plan, effectiveAt: decision.effectiveAt };
  const res = await createCheckout(db, { userId, plan: decision.plan, purpose: decision.purpose }, deps);
  return { outcome: "checkout", ...res };
}

// ─── applying a verified payment ─────────────────────────────────────────────

export type ApplyOutcome = "applied" | "already_applied" | "pending" | "failed" | "reversed" | "rejected" | "unknown_order";
export type ApplyResult = { outcome: ApplyOutcome; reason?: string; orderId?: string; userId?: string };

type Notice = { userId: string; title: string; message: string; type: "success" | "error" | "warning" };
type TxOutcome = { result: ApplyResult; notice?: Notice };

/**
 * Apply a provider-VERIFIED status to an order. Safe to call any number of times, from any number of
 * concurrent callers (callback, IPN, reconcile sweep): only the first COMPLETED call changes anything.
 */
export async function applyVerifiedPayment(db: DbLike, orderId: string, status: VerifiedStatus, opts: { now?: Date } = {}): Promise<ApplyResult> {
  const now = opts.now ?? new Date();
  const out = await db.transaction((tx) => applyInTx(tx, orderId, status, now));
  if (out.notice) await safeNotify(db, { ...out.notice });
  return out.result;
}

async function applyInTx(tx: DbLike, orderId: string, status: VerifiedStatus, now: Date): Promise<TxOutcome> {
  const [order] = await tx.select().from(paymentOrders).where(eq(paymentOrders.id, orderId)).for("update").limit(1);
  if (!order) return { result: { outcome: "unknown_order" } };
  const base = { orderId: order.id, userId: order.userId };

  const reject = async (reason: string, detail: string, extra: Record<string, unknown> = {}): Promise<TxOutcome> => {
    await logEvent(tx, {
      orderTrackingId: status.orderTrackingId,
      merchantRef: order.merchantRef,
      type: `REJECTED:${reason}`,
      payload: { orderId: order.id, statusCode: status.statusCode, ...extra },
      error: detail,
      now,
    });
    console.error(`[billing] payment rejected (${reason}) for order ${order.merchantRef}`);
    return { result: { outcome: "rejected", reason, ...base } };
  };

  // (e) The status must really be about THIS order.
  if (order.orderTrackingId && order.orderTrackingId !== status.orderTrackingId) {
    return reject("tracking_id_mismatch", "Status was fetched for a different order tracking id");
  }
  if (status.merchantReference && status.merchantReference !== order.merchantRef) {
    return reject("merchant_reference_mismatch", "Merchant reference does not match the stored order");
  }
  if (!status.merchantReference && (status.statusCode === 1 || status.statusCode === 3 || !order.orderTrackingId)) {
    return reject("merchant_reference_missing", "The provider did not echo the merchant reference");
  }

  const prev = order.statusCode;
  const alreadyApplied = order.appliedAt !== null;
  // Never let a stale poll move a completed order back to pending/failed, or anything out of "reversed".
  const writeStatus = prev !== 3 && !(alreadyApplied && (status.statusCode === 0 || status.statusCode === 2));
  const statusPatch = () => ({
    statusCode: status.statusCode,
    statusText: status.statusDescription ?? (order.statusText === "submitting" ? null : order.statusText),
    confirmationCode: status.confirmationCode ?? order.confirmationCode,
    paymentMethod: status.paymentMethod ?? order.paymentMethod,
  });
  const recordStatus = async (patch: Record<string, unknown> = {}) => {
    await tx
      .update(paymentOrders)
      .set({
        ...(writeStatus ? statusPatch() : {}),
        ...(order.orderTrackingId ? {} : { orderTrackingId: status.orderTrackingId }),
        ...patch,
        updatedAt: now,
      })
      .where(eq(paymentOrders.id, order.id));
  };

  switch (status.statusCode) {
    case 0: {
      await recordStatus();
      return { result: { outcome: alreadyApplied ? "already_applied" : "pending", ...base } };
    }
    case 2: {
      await recordStatus();
      return { result: { outcome: alreadyApplied ? "already_applied" : "failed", ...base } };
    }
    case 3: {
      if (prev === 3) return { result: { outcome: "reversed", reason: "already_reversed", ...base } };
      await recordStatus();
      let revoked = false;
      if (alreadyApplied) revoked = await revokeAccess(tx, order, now);
      await logEvent(tx, {
        orderTrackingId: status.orderTrackingId,
        merchantRef: order.merchantRef,
        type: "REVERSAL",
        payload: { orderId: order.id, reason: status.statusDescription ?? "REVERSED", wasApplied: alreadyApplied, accessRevoked: revoked },
        now,
      });
      return {
        result: { outcome: "reversed", ...base },
        notice: alreadyApplied
          ? { userId: order.userId, title: "Payment reversed", message: "A payment for your subscription was reversed, so your paid access has ended. Contact support if this is a mistake.", type: "error" }
          : undefined,
      };
    }
    default:
      break;
  }

  // ── COMPLETED ──
  if (prev === 3) return { result: { outcome: "reversed", reason: "completed_after_reversal", ...base } };
  if (alreadyApplied) {
    await recordStatus();
    return { result: { outcome: "already_applied", ...base } };
  }

  // (b) amount + currency must match what we asked for. Compared in integer cents.
  const expectedCents = toCents(order.amount);
  if (status.amount === null || status.currency === null || toCents(status.amount) !== expectedCents || status.currency.toUpperCase() !== order.currency.toUpperCase()) {
    await recordStatus({ statusCode: 1, statusText: "AMOUNT_MISMATCH" });
    return reject("amount_mismatch", `Expected ${centsToDecimal(expectedCents)} ${order.currency}, provider reported ${status.amount ?? "?"} ${status.currency ?? "?"}`, {
      expectedAmount: centsToDecimal(expectedCents),
      expectedCurrency: order.currency,
      amount: status.amount,
      currency: status.currency,
    });
  }

  // An upgrade is only valid against the exact period it was priced for (else it would buy a higher
  // plan for a different period than was paid for).
  let liveForUpgrade: SubRow | null = null;
  if (order.purpose === "upgrade") {
    liveForUpgrade = await lockLiveSub(tx, order.userId);
    const anchor = parseUpgradeAnchor(order.merchantRef);
    const valid =
      liveForUpgrade !== null &&
      liveForUpgrade.status === "active" &&
      liveForUpgrade.periodEnd !== null &&
      liveForUpgrade.periodEnd > now &&
      anchor !== null &&
      epochSec(liveForUpgrade.periodEnd) === anchor &&
      planRank(liveForUpgrade.plan) < planRank(order.plan);
    if (!valid) {
      await recordStatus({ statusCode: 1, statusText: "STALE_UPGRADE" });
      return reject("stale_upgrade", "Upgrade payment no longer matches the subscription period it was priced for; needs a manual refund");
    }
  }

  // The exactly-once gate (the order row is already locked FOR UPDATE; the predicate is belt and braces).
  const [gate] = await tx
    .update(paymentOrders)
    .set({ ...statusPatch(), ...(order.orderTrackingId ? {} : { orderTrackingId: status.orderTrackingId }), appliedAt: now, updatedAt: now })
    .where(and(eq(paymentOrders.id, order.id), isNull(paymentOrders.appliedAt)))
    .returning({ id: paymentOrders.id });
  if (!gate) return { result: { outcome: "already_applied", ...base } };

  const applied = await applyEntitlement(tx, order, liveForUpgrade, now);
  await tx.update(paymentOrders).set({ subscriptionId: applied.sub.id }).where(eq(paymentOrders.id, order.id));
  if (!applied.entitled) {
    await logEvent(tx, {
      orderTrackingId: status.orderTrackingId,
      merchantRef: order.merchantRef,
      type: "NOTE:admin_plan_preserved",
      payload: { orderId: order.id, plan: order.plan },
      now,
    });
  }
  const until = applied.sub.periodEnd;
  return {
    result: { outcome: "applied", ...base },
    notice: {
      userId: order.userId,
      title: order.purpose === "upgrade" ? `Upgraded to ${PLAN_NAMES[order.plan]}` : "Payment received",
      message: `Your ${PLAN_NAMES[order.plan]} plan is active until ${fmtDate(until)}.`,
      type: "success",
    },
  };
}

/** Subscription + users.plan changes for a COMPLETED order. Runs inside the apply transaction. */
async function applyEntitlement(tx: DbLike, order: OrderRow, liveForUpgrade: SubRow | null, now: Date): Promise<{ sub: SubRow; entitled: boolean }> {
  if (order.purpose === "upgrade" && liveForUpgrade) {
    const [sub] = await tx
      .update(subscriptions)
      .set({ plan: order.plan, pendingPlan: null, updatedAt: now })
      .where(eq(subscriptions.id, liveForUpgrade.id))
      .returning();
    return { sub, entitled: await grantEntitlement(tx, order.userId, order.plan, now) };
  }

  // initial / renewal: find the subscription this payment extends.
  let sub = await lockLiveSub(tx, order.userId);
  const reactivating = sub === null;
  if (!sub && order.subscriptionId) {
    const [prior] = await tx.select().from(subscriptions).where(eq(subscriptions.id, order.subscriptionId)).for("update").limit(1);
    sub = prior ?? null;
  }
  if (!sub) {
    const [created] = await tx.insert(subscriptions).values({ userId: order.userId, plan: order.plan, status: "approval_pending" }).returning();
    sub = created;
  }

  const running = !reactivating && (sub.status === "active" || sub.status === "past_due") && sub.periodEnd !== null;
  const ahead = running && sub.periodEnd !== null && sub.periodEnd > now;
  const start = ahead ? (sub.periodEnd as Date) : now; // extend from max(now, period_end)
  // A stale lower-plan order never downgrades someone who is still inside a higher paid period.
  const plan: PaidPlan = ahead && planRank(order.plan) < planRank(sub.plan) ? sub.plan : order.plan;
  const [updated] = await tx
    .update(subscriptions)
    .set({
      status: "active",
      plan,
      periodStart: start,
      periodEnd: addPeriod(start),
      graceUntil: null,
      cancelAtPeriodEnd: false,
      pendingPlan: ahead && plan !== order.plan ? sub.pendingPlan : null,
      updatedAt: now,
    })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  return { sub: updated, entitled: await grantEntitlement(tx, order.userId, plan, now) };
}

/** (d) Reversal: end the subscription this payment backed and drop the plan (if it came from a subscription). */
async function revokeAccess(tx: DbLike, order: OrderRow, now: Date): Promise<boolean> {
  if (!order.subscriptionId) return false;
  const rows = await tx
    .update(subscriptions)
    .set({ status: "cancelled", periodEnd: now, graceUntil: null, cancelAtPeriodEnd: false, pendingPlan: null, updatedAt: now })
    .where(and(eq(subscriptions.id, order.subscriptionId), inArray(subscriptions.status, [...LIVE_STATUSES])))
    .returning({ id: subscriptions.id });
  await revokeEntitlement(tx, order.userId, now);
  return rows.length > 0;
}

// ─── sweeps ──────────────────────────────────────────────────────────────────

/** Parameters per lookup statement (Postgres allows 65 535 bind parameters; stay far below). */
const REF_LOOKUP_CHUNK = 1000;

/** Which of these merchant references already have a payment_orders row? One statement per 1000 references. */
async function existingMerchantRefs(db: DbLike, refs: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < refs.length; i += REF_LOOKUP_CHUNK) {
    const rows = await db
      .select({ merchantRef: paymentOrders.merchantRef })
      .from(paymentOrders)
      .where(inArray(paymentOrders.merchantRef, refs.slice(i, i + REF_LOOKUP_CHUNK)));
    for (const r of rows) found.add(r.merchantRef);
  }
  return found;
}

/**
 * Create the renewal order for subscriptions whose period ends within 3 days (and for past_due ones
 * that have none). The merchant reference is deterministic per period, so any number of concurrent
 * sweeps create exactly ONE order and only the winner notifies. No provider call is made here: the
 * hosted checkout is opened when the user presses "Renew".
 */
export async function runRenewalSweep(
  db: DbLike,
  deps: { prices: PlanPrices; currency: string; now?: () => Date },
  opts: { limit?: number; /** restrict to one user (tests, support tooling) */ userId?: string; /** restrict to these users (tests) */ userIds?: string[] } = {},
): Promise<{ created: number }> {
  const now = clock(deps);
  const rows = await db
    .select({ sub: subscriptions })
    .from(subscriptions)
    .innerJoin(users, eq(users.id, subscriptions.userId))
    .where(
      and(
        eq(subscriptions.cancelAtPeriodEnd, false),
        ne(users.planSource, "admin"),
        opts.userId ? eq(subscriptions.userId, opts.userId) : undefined,
        opts.userIds ? inArray(subscriptions.userId, opts.userIds) : undefined,
        or(
          and(eq(subscriptions.status, "active"), lte(subscriptions.periodEnd, new Date(now.getTime() + RENEWAL_LEAD_MS))),
          eq(subscriptions.status, "past_due"),
        ),
      ),
    )
    .orderBy(subscriptions.periodEnd)
    .limit(opts.limit ?? 500);

  // Which of these candidates still need an order? Every run re-selects everyone inside the 3-day window (and everyone
  // past_due), and once a period's order exists the per-row transaction below is a pure no-op, so look the existing
  // references up in ONE query and only open a transaction for the rest. This is only a shortcut: the INSERT ... ON
  // CONFLICT DO NOTHING below stays the guard, so concurrent sweeps still create exactly one order per period and only
  // the winner notifies. The reference is the same deterministic one the insert uses; a reference that exists is exactly
  // the case in which that insert would conflict, whoever created the order and whatever its status is now.
  const candidates: { sub: SubRow; plan: PaidPlan; price: number; ref: string }[] = [];
  for (const { sub } of rows) {
    if (!sub.periodEnd) continue;
    const plan = renewalPlan(sub);
    const price = deps.prices[plan];
    if (price == null) continue;
    // A scheduled downgrade is paid only once the current (higher) period is over.
    if (sub.status === "active" && isPendingDowngrade(sub)) continue;
    candidates.push({ sub, plan, price, ref: renewalBaseRef(sub.id, sub.periodEnd) });
  }
  const settled = await existingMerchantRefs(db, candidates.map((c) => c.ref));

  let created = 0;
  for (const { sub, plan, price, ref } of candidates) {
    if (settled.has(ref)) continue; // this period's order already exists
    const inserted = await db.transaction(async (tx) => {
      const [o] = await tx
        .insert(paymentOrders)
        .values({
          userId: sub.userId,
          subscriptionId: sub.id,
          provider: "pesapal",
          merchantRef: renewalBaseRef(sub.id, sub.periodEnd as Date),
          purpose: "renewal",
          plan,
          amount: centsToDecimal(toCents(price)),
          currency: deps.currency,
        })
        .onConflictDoNothing({ target: paymentOrders.merchantRef })
        .returning({ id: paymentOrders.id });
      if (o && sub.status === "active") {
        await createNotification(tx, {
          userId: sub.userId,
          title: `Renew your ${PLAN_NAMES[plan]} plan`,
          message: `Your ${PLAN_NAMES[sub.plan]} plan ends on ${fmtDate(sub.periodEnd)}. Renew with M-Pesa, Airtel Money or card to keep access. Renewals are manual payments.`,
          type: "warning",
          link: "/billing",
        });
      }
      return !!o;
    });
    if (inserted) created++;
  }
  return { created };
}

/**
 * A paid plan whose subscription is already over is healed only once its users row has been idle this long.
 * Why: the heal decides on a snapshot, and a payment applied at the same moment writes the subscription AND the
 * plan in one transaction; the idle margin lets that fresh write win (see healOrphanedPlans).
 */
const HEAL_MIN_IDLE_MS = 2 * 60_000;

/**
 * Heal users left on a subscription-granted paid plan with NO live subscription behind it. Before the expiry
 * transitions were atomic, a crash between "subscription -> cancelled/expired" and the downgrade left exactly
 * that state, and the sweep could never find the row again (its WHERE only selects live subscriptions).
 * Same guard as revokeEntitlements, one set-based statement for the whole batch:
 *  - plan_source = 'subscription' only: admin grants and default plans are never touched;
 *  - no approval_pending / active / past_due subscription: anything live is left to the normal flow;
 *  - users.updated_at older than HEAL_MIN_IDLE_MS: under READ COMMITTED a payment that commits while this
 *    statement waits on the users row would be re-checked against the OLD snapshot of subscriptions, and the
 *    customer who just paid would be downgraded. grantEntitlement stamps updated_at, so that re-check fails instead.
 * Quiet on purpose: no notification (the missed "ended" notice cannot be reconstructed for a past date).
 */
async function healOrphanedPlans(db: DbLike, now: Date, limit: number, only: { userId?: string; userIds?: string[] }): Promise<number> {
  const idleBefore = new Date(now.getTime() - HEAL_MIN_IDLE_MS);
  const orphans = db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.planSource, "subscription"),
        lte(users.updatedAt, idleBefore),
        only.userId ? eq(users.id, only.userId) : undefined,
        only.userIds ? inArray(users.id, only.userIds) : undefined,
        notExists(db.select({ one: sql`1` }).from(subscriptions).where(and(eq(subscriptions.userId, users.id), inArray(subscriptions.status, [...LIVE_STATUSES])))),
      ),
    )
    .limit(limit);
  const rows = await db
    .update(users)
    .set({ plan: "free", planSource: "default", updatedAt: now })
    .where(and(inArray(users.id, orphans), eq(users.planSource, "subscription"), lte(users.updatedAt, idleBefore)))
    .returning({ id: users.id });
  return rows.length;
}

/**
 * Period-end bookkeeping. Idempotent and safe to run concurrently with payments (the UPDATEs re-check
 * their predicates, and apply holds the subscription row lock):
 *   approval_pending untouched for 7 days   -> cancelled
 *   active, period over, user cancelled     -> cancelled (+ downgrade)
 *   active, period over                     -> past_due, grace_until = period_end + 3 days
 *   past_due, grace over                    -> expired (+ downgrade)
 *   paid plan with no live subscription     -> free (heal, see healOrphanedPlans)
 *
 * Crash safety: a transition that ends access changes the subscription status AND downgrades the plan in ONE
 * transaction (locks are taken subscriptions -> users, the same order payments use), so a crash can never leave
 * a user on a paid plan whose subscription no later sweep would select. The in-app notification is written
 * after the commit, outside the transaction.
 */
export async function runExpirySweep(
  db: DbLike,
  opts: { now?: Date; limit?: number; /** restrict to one user (tests, support tooling) */ userId?: string; /** restrict to these users (tests) */ userIds?: string[] } = {},
): Promise<{ cancelled: number; pastDue: number; expired: number; stale: number; healed: number }> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 200;
  const only = and(opts.userId ? eq(subscriptions.userId, opts.userId) : undefined, opts.userIds ? inArray(subscriptions.userId, opts.userIds) : undefined);
  const counts = { cancelled: 0, pastDue: 0, expired: 0, stale: 0, healed: 0 };

  const stale = await db
    .update(subscriptions)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(subscriptions.status, "approval_pending"), lte(subscriptions.updatedAt, new Date(now.getTime() - STALE_PENDING_MS)), only))
    .returning({ id: subscriptions.id });
  counts.stale = stale.length;

  const idsOf = async (where: ReturnType<typeof and>) =>
    (await db.select({ id: subscriptions.id }).from(subscriptions).where(where).limit(limit)).map((r) => r.id);

  // 1. cancelled subscriptions whose paid period is over
  const cancelWhere = and(eq(subscriptions.status, "active"), eq(subscriptions.cancelAtPeriodEnd, true), lte(subscriptions.periodEnd, now), only);
  const cancelIds = await idsOf(cancelWhere);
  if (cancelIds.length) {
    const rows = await db.transaction(async (tx) => {
      const done = await tx
        .update(subscriptions)
        .set({ status: "cancelled", graceUntil: null, pendingPlan: null, updatedAt: now })
        .where(and(inArray(subscriptions.id, cancelIds), cancelWhere))
        .returning({ userId: subscriptions.userId, plan: subscriptions.plan });
      await revokeEntitlements(tx, done.map((r) => r.userId), now);
      return done;
    });
    for (const r of rows) {
      await safeNotify(db, { userId: r.userId, title: "Subscription ended", message: `Your ${PLAN_NAMES[r.plan]} subscription has ended. You're back on the Free plan.`, type: "info" });
    }
    counts.cancelled += rows.length;
  }

  // 2. unpaid period ends -> past_due with a 3 day grace window anchored on period_end
  const lapseWhere = and(eq(subscriptions.status, "active"), eq(subscriptions.cancelAtPeriodEnd, false), lte(subscriptions.periodEnd, now), only);
  const lapseIds = await idsOf(lapseWhere);
  if (lapseIds.length) {
    const rows = await db
      .update(subscriptions)
      .set({ status: "past_due", graceUntil: sql`${subscriptions.periodEnd} + ${sql.raw(`interval '${GRACE_DAYS * 24} hours'`)}`, updatedAt: now })
      .where(and(inArray(subscriptions.id, lapseIds), lapseWhere))
      .returning({ userId: subscriptions.userId, plan: subscriptions.plan, graceUntil: subscriptions.graceUntil });
    for (const r of rows) {
      await safeNotify(db, {
        userId: r.userId,
        title: "Payment overdue",
        message: `Your ${PLAN_NAMES[r.plan]} period has ended. Pay by ${fmtDate(r.graceUntil)} to keep your plan.`,
        type: "warning",
      });
    }
    counts.pastDue += rows.length;
  }

  // 3. grace over -> expired (or cancelled if the user had cancelled) + downgrade
  const graceWhere = and(eq(subscriptions.status, "past_due"), lte(subscriptions.graceUntil, now), only);
  const graceIds = await idsOf(graceWhere);
  if (graceIds.length) {
    const rows = await db.transaction(async (tx) => {
      const done = await tx
        .update(subscriptions)
        .set({
          status: sql`case when ${subscriptions.cancelAtPeriodEnd} then 'cancelled' else 'expired' end`,
          pendingPlan: null,
          updatedAt: now,
        })
        .where(and(inArray(subscriptions.id, graceIds), graceWhere))
        .returning({ userId: subscriptions.userId, plan: subscriptions.plan });
      await revokeEntitlements(tx, done.map((r) => r.userId), now);
      return done;
    });
    for (const r of rows) {
      await safeNotify(db, { userId: r.userId, title: "Subscription expired", message: `Your ${PLAN_NAMES[r.plan]} plan expired because the renewal wasn't paid. You're back on the Free plan.`, type: "error" });
    }
    counts.expired += rows.length;
  }

  // 4. heal what an earlier, non-atomic sweep left behind (see healOrphanedPlans)
  counts.healed = await healOrphanedPlans(db, now, limit, { userId: opts.userId, userIds: opts.userIds });
  return counts;
}

/**
 * Safety net for lost IPNs: poll the provider for orders that have a tracking id, are still unpaid
 * and have been quiet for 10+ minutes. Oldest-touched first; every poll bumps updated_at so a batch
 * of dead orders cannot starve the rest. Orders older than 3 days are marked ABANDONED (an IPN can
 * still settle them later).
 */
export async function runReconcileSweep(
  db: DbLike,
  deps: { provider: PaymentProvider; now?: () => Date },
  opts: { limit?: number; /** restrict to one user (tests, support tooling) */ userId?: string } = {},
): Promise<{ polled: number; applied: number; abandoned: number; errors: number }> {
  const now = clock(deps);
  const unpaid = and(
    opts.userId ? eq(paymentOrders.userId, opts.userId) : undefined,
    isNotNull(paymentOrders.orderTrackingId),
    isNull(paymentOrders.appliedAt),
    or(isNull(paymentOrders.statusCode), eq(paymentOrders.statusCode, 0)),
    or(isNull(paymentOrders.statusText), notInArray(paymentOrders.statusText, ["submitting", "superseded", "ABANDONED"])),
  );

  const abandoned = await db
    .update(paymentOrders)
    .set({ statusCode: 2, statusText: "ABANDONED", updatedAt: now })
    .where(and(unpaid, lte(paymentOrders.createdAt, new Date(now.getTime() - RECONCILE_GIVE_UP_MS))))
    .returning({ id: paymentOrders.id });

  const due = await db
    .select()
    .from(paymentOrders)
    .where(and(unpaid, lte(paymentOrders.updatedAt, new Date(now.getTime() - RECONCILE_MIN_AGE_MS))))
    .orderBy(paymentOrders.updatedAt)
    .limit(opts.limit ?? 25);

  const res = { polled: 0, applied: 0, abandoned: abandoned.length, errors: 0 };
  for (const order of due) {
    res.polled++;
    try {
      const status = await deps.provider.getStatus(order.orderTrackingId as string);
      const r = await applyVerifiedPayment(db, order.id, status, { now });
      if (r.outcome === "applied") res.applied++;
    } catch (e) {
      res.errors++;
      console.error("[billing] reconcile failed for order", order.merchantRef, e instanceof Error ? e.message : "unknown error");
      await db.update(paymentOrders).set({ updatedAt: now }).where(eq(paymentOrders.id, order.id));
    }
  }
  return res;
}

/** Audit retention: drop notifications that matched no order (forged / foreign ids) after 30 days. */
export async function purgeUnmatchedEvents(db: DbLike, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);
  const rows = (await db.execute(sql`
    delete from payment_events e
    where e.received_at < ${cutoff.toISOString()}::timestamptz
      and not exists (
        select 1 from payment_orders o
        where o.order_tracking_id = e.order_tracking_id or o.merchant_ref = e.merchant_ref
      )
    returning e.id
  `)) as unknown as unknown[];
  return rows.length;
}
