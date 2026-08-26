"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { CreditCard, CheckCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const STATUS_LABELS: Record<string, string> = {
  on_trial: "Trial",
  active: "Active",
  paused: "Paused",
  past_due: "Past due",
  unpaid: "Unpaid",
  cancelled: "Cancelled (access until period end)",
  expired: "Expired",
};

function formatDate(ms?: number): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function BillingCard() {
  const user = useQuery(api.users.current);
  const createCheckoutUrl = useAction(api.actions.billing.createCheckoutUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user === undefined) return null;
  if (user === null) return null;

  const plan = user.plan ?? "free";
  const isPro = plan === "pro";
  const isElite = plan === "elite";
  const renewsAt = formatDate(user.subscriptionRenewsAt);
  const endsAt = formatDate(user.subscriptionEndsAt);

  const handleUpgrade = async () => {
    setLoading(true);
    setError(null);
    try {
      const { url } = await createCheckoutUrl({});
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout. Please try again.");
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-primary" />
          Billing
        </CardTitle>
        <CardDescription>Manage your plan and subscription.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3 p-3 border rounded-md bg-secondary/50">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground mb-0.5">Current plan</p>
            <p className="font-medium text-sm capitalize flex items-center gap-1.5">
              {plan}
              {(isPro || isElite) && <CheckCircle className="h-3.5 w-3.5 text-primary" />}
            </p>
            {user.subscriptionStatus && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {STATUS_LABELS[user.subscriptionStatus] ?? user.subscriptionStatus}
                {user.subscriptionStatus !== "cancelled" && renewsAt && ` · renews ${renewsAt}`}
                {user.subscriptionStatus === "cancelled" && endsAt && ` · access until ${endsAt}`}
              </p>
            )}
          </div>
          {!isPro && !isElite && (
            <Button size="sm" className="shrink-0" disabled={loading} onClick={handleUpgrade}>
              {loading ? "Redirecting…" : "Upgrade to Pro"}
            </Button>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        {!isPro && !isElite && (
          <p className="text-xs text-muted-foreground">
            Pro unlocks unlimited uploads, AI video generation, auto-publish, full analytics, and the AI chat assistant — $29/mo.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
