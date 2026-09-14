"use client";

import { useEffect, useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { CreditCard, CheckCircle, Sparkles } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<string, string> = {
  approval_pending: "Awaiting approval",
  active: "Active",
  suspended: "Suspended",
  cancelled: "Cancelled",
  expired: "Expired",
};

const USAGE_LABELS: Record<string, string> = {
  videosUploaded: "Video uploads",
  metadataGenerated: "AI metadata generations",
  veoGenerated: "AI video generations (Veo)",
  aiMessagesUsed: "AI assistant messages",
};

const PRO_PRICE_USD = 19;

const TIERS = [
  {
    key: "free",
    name: "Free",
    price: "$0",
    tagline: "Forever free, no card required",
    features: [
      "10 video uploads / month",
      "5 AI metadata generations / month",
      "No AI video generation",
      "No AI chat assistant",
      "YouTube publishing & basic scheduling",
    ],
  },
  {
    key: "pro",
    name: "Pro",
    price: `$${PRO_PRICE_USD}/mo`,
    tagline: "For serious creators",
    features: [
      "Unlimited video uploads",
      "Unlimited AI metadata generations",
      "5 AI video generations (Veo) / month",
      "200 AI assistant messages / month",
      "Auto-publish queue, full analytics, Discord/Telegram/email alerts",
    ],
    highlight: true,
  },
  {
    key: "elite",
    name: "Elite",
    price: "Invite only",
    tagline: "Assigned manually by an admin",
    features: [
      "Unlimited video uploads",
      "Unlimited AI metadata generations",
      "Unlimited AI video generations (Veo)",
      "1000 AI assistant messages / month",
      "Everything in Pro",
    ],
  },
];

function formatDate(ms?: number): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = limit >= 999999;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const atLimit = !unlimited && used >= limit;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-medium tabular-nums", atLimit && "text-destructive")}>
          {used} {unlimited ? "" : `/ ${limit}`}
          {unlimited && <span className="text-muted-foreground font-normal"> (unlimited)</span>}
        </span>
      </div>
      {!unlimited && (
        <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", atLimit ? "bg-destructive" : "bg-primary")}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default function BillingPage() {
  const user = useQuery(api.users.current);
  const usageSummary = useQuery(api.usageLedger.getUsageSummary);
  const createCheckoutUrl = useAction(api.actions.paypal.createCheckoutUrl);
  const checkSubscriptionStatus = useAction(api.actions.paypal.checkSubscriptionStatus);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const billing = params.get("billing");
    const subscriptionId = params.get("subscription_id");
    if (billing === "cancel") {
      // Deferred via queueMicrotask so this doesn't set state synchronously
      // within the effect body itself (react-hooks/set-state-in-effect).
      queueMicrotask(() => {
        setBanner({ success: false, message: "Checkout was cancelled. No changes were made to your plan." });
      });
    } else if (billing === "callback" && subscriptionId) {
      queueMicrotask(() => {
        setBanner({ success: true, message: "Confirming your subscription…" });
      });
      checkSubscriptionStatus({ subscriptionId })
        .then((result: { status: string }) => {
          if (result.status === "active") {
            setBanner({ success: true, message: "Subscription confirmed! Your account is now Pro." });
          } else if (result.status === "approval_pending") {
            setBanner({ success: true, message: "Your subscription is still processing — this page will reflect your new plan once it clears." });
          } else {
            setBanner({ success: false, message: "Subscription did not activate. No changes were made to your plan." });
          }
        })
        .catch(() => {
          setBanner({ success: false, message: "Could not confirm subscription status. Contact support if you were charged." });
        });
    }
  }, [checkSubscriptionStatus]);

  if (user === undefined || usageSummary === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const plan = user?.plan ?? "free";
  const isPro = plan === "pro";
  const isElite = plan === "elite";
  const renewsAt = formatDate(user?.subscriptionRenewsAt);

  const handleUpgrade = async () => {
    setLoading(true);
    setError(null);
    try {
      const { redirectUrl } = await createCheckoutUrl({});
      window.location.href = redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Billing &amp; Plans</h1>
        <p className="text-muted-foreground">
          Manage your subscription, track usage against your plan, and see what each tier unlocks.
        </p>
      </div>

      {banner && (
        <div
          className={cn(
            "flex items-start gap-2 text-sm p-2.5 rounded-md",
            banner.success ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
          )}
        >
          {banner.message}
        </div>
      )}

      {/* Current plan + upgrade CTA */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            Current Plan
          </CardTitle>
          <CardDescription>Payments are processed by PayPal.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3 p-3 border rounded-md bg-secondary/50">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground mb-0.5">Plan</p>
              <p className="font-medium text-sm capitalize flex items-center gap-1.5">
                {plan}
                {(isPro || isElite) && <CheckCircle className="h-3.5 w-3.5 text-primary" />}
              </p>
              {user?.subscriptionStatus && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {STATUS_LABELS[user.subscriptionStatus] ?? user.subscriptionStatus}
                  {user.subscriptionStatus === "active" && renewsAt && ` · renews ${renewsAt}`}
                </p>
              )}
            </div>
            {!isPro && !isElite && (
              <Button size="sm" className="shrink-0" disabled={loading} onClick={handleUpgrade}>
                {loading ? "Redirecting…" : "Upgrade to Pro"}
              </Button>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {!isPro && !isElite && (
            <p className="text-xs text-muted-foreground">
              Pro unlocks unlimited uploads, AI video generation, auto-publish, full analytics, and the AI chat assistant.
              Billed monthly via PayPal — cancel anytime from your PayPal account.
            </p>
          )}
          {isElite && (
            <p className="text-xs text-muted-foreground">
              Elite is assigned manually by an admin and isn&apos;t self-serve upgradeable.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Usage this month */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Usage This Month
          </CardTitle>
          <CardDescription>Resets on the 1st of each month. Limits are enforced per your current plan.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {(Object.keys(USAGE_LABELS) as Array<keyof typeof USAGE_LABELS>).map((field) => {
            const stat = usageSummary.usage[field as keyof typeof usageSummary.usage];
            if (!stat) return null;
            return (
              <UsageBar key={field} label={USAGE_LABELS[field]} used={stat.used} limit={stat.limit} />
            );
          })}
        </CardContent>
      </Card>

      {/* Tier comparison */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Compare Tiers</h2>
        <div className="grid md:grid-cols-3 gap-4">
          {TIERS.map((tier) => {
            const isCurrent = tier.key === plan;
            return (
              <Card
                key={tier.key}
                className={cn(
                  "relative",
                  tier.highlight && "border-primary border-2",
                  isCurrent && "ring-2 ring-primary/40"
                )}
              >
                {isCurrent && (
                  <span className="absolute top-4 right-4 text-xs font-bold px-2.5 py-1 rounded-full bg-primary text-white">
                    Current
                  </span>
                )}
                <CardHeader>
                  <CardTitle className="text-base">{tier.name}</CardTitle>
                  <p className="text-2xl font-extrabold">{tier.price}</p>
                  <CardDescription>{tier.tagline}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2.5">
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm">
                        <CheckCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  {tier.key === "pro" && !isPro && !isElite && (
                    <Button className="w-full mt-6" disabled={loading} onClick={handleUpgrade}>
                      {loading ? "Redirecting…" : "Upgrade to Pro"}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
