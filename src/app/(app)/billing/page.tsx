"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, CreditCard, History, Info, Smartphone, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PaymentHistory } from "@/components/billing/payment-history";
import { PlanCards } from "@/components/billing/plan-cards";
import { PLAN_NAMES, RENEWAL_LEAD_DAYS, SUBSCRIPTION_STATUS_LABELS, formatDate, formatMoney, type PaidPlanKey, type PlanKey } from "@/components/billing/plans";
import { UsageMeters } from "@/components/billing/usage-meters";
import { api, useAction, useMutation, useQuery } from "@/lib/rpc/client";
import { cn } from "@/lib/utils";

type Tone = "success" | "error" | "info" | "warning";
const TONE: Record<Tone, string> = {
  success: "bg-success/10 text-success",
  error: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  info: "bg-secondary text-foreground",
};

function Notice({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const Icon = tone === "success" ? CheckCircle : tone === "info" ? Info : AlertTriangle;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-2 text-sm p-3 rounded-md", TONE[tone])}>
      <Icon className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const RETURN_STATES = ["success", "failed", "pending", "cancelled"] as const;
type ReturnState = (typeof RETURN_STATES)[number];

export default function BillingPage() {
  const status = useQuery(api.billing.getStatus);
  const createCheckout = useAction(api.billing.createCheckout);
  const changePlan = useAction(api.billing.changePlan);
  const cancel = useMutation(api.billing.cancel);
  const resume = useMutation(api.billing.resume);
  const queryClient = useQueryClient();

  const [returnState, setReturnState] = useState<ReturnState | null>(null);
  const [busy, setBusy] = useState<PlanKey | "renew" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  // Pesapal sends the customer back to /billing?status=success|failed|pending|cancelled. The query
  // string only picks the wording; the server has already verified the payment with Pesapal.
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("status");
    if (value && (RETURN_STATES as readonly string[]).includes(value)) {
      // Deferred so state isn't set synchronously inside the effect body (react-hooks/set-state-in-effect).
      queueMicrotask(() => setReturnState(value as ReturnState));
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const subStatus = status?.subscription?.status;
  const waitingForPayment = returnState === "pending" || (returnState === "success" && subStatus !== "active");
  useEffect(() => {
    if (!waitingForPayment) return;
    let ticks = 0;
    const id = setInterval(() => {
      ticks += 1;
      void queryClient.invalidateQueries({ queryKey: ["rpc"] });
      if (ticks >= 20) clearInterval(id); // ~80s, then the user can refresh
    }, 4000);
    return () => clearInterval(id);
  }, [waitingForPayment, queryClient]);

  if (status === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const plan = status.plan as PlanKey;
  const sub = status.subscription;
  const hasLive = !!sub && (sub.status === "active" || sub.status === "past_due");
  const nextPrice = sub ? status.prices[sub.nextPlan] : undefined;
  const scheduledPlan = sub?.pendingPlan && sub.pendingPlan !== sub.plan && sub.status === "active" ? (sub.pendingPlan as PlanKey) : undefined;

  const go = (url: string) => {
    window.location.href = url;
  };

  const run = async (key: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const onSelect = (target: PaidPlanKey) =>
    run(target, async () => {
      if (!hasLive) {
        go((await createCheckout({ plan: target })).redirectUrl);
        return;
      }
      const r = await changePlan({ plan: target });
      if (r.outcome === "checkout" && r.redirectUrl) go(r.redirectUrl);
      else if (r.outcome === "scheduled") setNotice(`Your plan will change to ${PLAN_NAMES[(r.plan ?? target) as PlanKey]}${r.effectiveAt ? ` on ${formatDate(r.effectiveAt)}` : " at your next renewal"}.`);
      else setNotice("Nothing to change.");
    });

  const onRenew = () =>
    run("renew", async () => {
      if (!sub) return;
      go((await createCheckout({ plan: sub.nextPlan })).redirectUrl);
    });

  const onCancel = () =>
    run("cancel", async () => {
      await cancel({});
      setConfirmCancel(false);
      setNotice(`Cancelled. You keep ${sub ? PLAN_NAMES[sub.plan] : "your plan"} until ${formatDate(sub?.periodEnd) ?? "the end of the period"}. You won't be charged again.`);
    });

  const onResume = () =>
    run("cancel", async () => {
      await resume({});
      setNotice("Welcome back. Your plan will stay on after this period if you renew.");
    });

  const returnBanner = (() => {
    switch (returnState) {
      case "success":
        return waitingForPayment ? (
          <Notice tone="info">Payment received. Activating your plan…</Notice>
        ) : (
          <Notice tone="success">Payment confirmed. Your plan is now {PLAN_NAMES[plan]}.</Notice>
        );
      case "pending":
        return <Notice tone="info">Your payment is still processing. Mobile money prompts can take a minute. This page updates by itself once it clears.</Notice>;
      case "failed":
        return <Notice tone="error">The payment didn&apos;t go through, so nothing changed on your plan. If you were charged, contact support and mention the time of the payment.</Notice>;
      case "cancelled":
        return <Notice tone="info">Checkout cancelled. No changes were made to your plan.</Notice>;
      default:
        return null;
    }
  })();

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Billing &amp; Plans</h1>
        <p className="text-muted-foreground">Manage your plan, track usage against it, and see what each tier unlocks.</p>
      </div>

      <div className="space-y-3">
        {returnBanner}
        {notice && <Notice tone="success">{notice}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        {sub?.status === "past_due" && (
          <Notice tone="warning">
            Your {PLAN_NAMES[sub.plan]} period has ended and the payment is overdue. Pay by <strong>{formatDate(sub.graceUntil)}</strong> to keep your plan, after that your account returns to Free.
          </Notice>
        )}
        {sub?.status === "active" && sub.renewalOpen && !sub.cancelAtPeriodEnd && (
          <Notice tone="warning">
            Your {PLAN_NAMES[sub.plan]} plan ends on <strong>{formatDate(sub.periodEnd)}</strong>. Renew to keep access.
          </Notice>
        )}
        {scheduledPlan && (
          <Notice tone="info">
            Your plan will switch to {PLAN_NAMES[scheduledPlan]} on {formatDate(sub?.periodEnd)}. You keep {PLAN_NAMES[plan]} until then.
          </Notice>
        )}
        {sub?.cancelAtPeriodEnd && sub.status !== "cancelled" && sub.status !== "expired" && (
          <Notice tone="info">
            Your subscription is cancelled and ends on {formatDate(sub.status === "past_due" ? (sub.graceUntil ?? sub.periodEnd) : sub.periodEnd)}.
          </Notice>
        )}
        {!status.selfServe && <Notice tone="info">Your plan is managed by an administrator, so it can&apos;t be changed here.</Notice>}
        {status.selfServe && !status.paymentsEnabled && <Notice tone="info">Online payments aren&apos;t switched on yet. Please check back soon.</Notice>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" aria-hidden />
            Current Plan
          </CardTitle>
          <CardDescription>Pay with M-Pesa, Airtel Money or Visa/Mastercard. Payments are processed securely by Pesapal.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 p-3 border rounded-md bg-secondary/50">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Plan</p>
              <p className="font-medium text-sm flex items-center gap-1.5">
                {PLAN_NAMES[plan]}
                {plan !== "free" && <CheckCircle className="h-3.5 w-3.5 text-primary" aria-hidden />}
              </p>
              {sub && (sub.status === "active" || sub.status === "past_due") && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {SUBSCRIPTION_STATUS_LABELS[sub.status]}
                  {sub.status === "active" && sub.periodEnd && (sub.cancelAtPeriodEnd ? ` · ends ${formatDate(sub.periodEnd)}` : ` · paid through ${formatDate(sub.periodEnd)}`)}
                </p>
              )}
              {sub?.status === "approval_pending" && <p className="text-xs text-muted-foreground mt-0.5">Checkout started, waiting for payment</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {sub && sub.renewalOpen && status.selfServe && !sub.cancelAtPeriodEnd && (
                <Button size="sm" disabled={busy !== null || !status.paymentsEnabled} onClick={onRenew}>
                  {busy === "renew" ? "Redirecting…" : `Renew${nextPrice !== undefined ? ` · ${formatMoney(nextPrice, status.currency)}` : ""}`}
                </Button>
              )}
              {hasLive && status.selfServe && !sub?.cancelAtPeriodEnd && (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
                  Cancel plan
                </Button>
              )}
              {hasLive && status.selfServe && sub?.cancelAtPeriodEnd && (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={onResume}>
                  Keep my plan
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Smartphone className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
            <span>
              Renewals are manual payments, nothing is charged automatically. We send a reminder {RENEWAL_LEAD_DAYS} days before your plan ends, and you get a {RENEWAL_LEAD_DAYS}-day grace period after that.
            </span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" aria-hidden />
            Usage This Month
          </CardTitle>
          <CardDescription>Resets on the 1st of each month. Limits are enforced per your current plan.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <UsageMeters items={status.usage.items} />
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold mb-4">Compare Tiers</h2>
        <PlanCards
          currentPlan={plan}
          scheduledPlan={scheduledPlan}
          scheduledAt={sub?.periodEnd}
          hasSubscription={hasLive}
          prices={status.prices}
          currency={status.currency}
          selfServe={status.selfServe}
          paymentsEnabled={status.paymentsEnabled}
          busyPlan={busy === "renew" || busy === "cancel" ? null : busy}
          onSelect={onSelect}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" aria-hidden />
            Payment History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PaymentHistory payments={status.payments} />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel your plan?"
        description={`You keep ${sub ? PLAN_NAMES[sub.plan] : "your plan"} until ${formatDate(sub?.periodEnd) ?? "the end of the period"}, then your account returns to Free. You won't be charged again.`}
        cancelText="Keep my plan"
        confirmText="Cancel plan"
        variant="destructive"
        isLoading={busy === "cancel"}
        onConfirm={onCancel}
      />
    </div>
  );
}
