"use client";

import { CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PLAN_COPY, PLAN_NAMES, PLAN_RANK, formatDate, formatMoney, type PaidPlanKey, type PlanKey } from "./plans";

export type PlanCardsProps = {
  /** users.plan: what the account can use right now. */
  currentPlan: PlanKey;
  /** plan scheduled to start at the next renewal, if any */
  scheduledPlan?: PlanKey;
  scheduledAt?: number;
  /** a paid subscription exists (active or in its grace period) */
  hasSubscription: boolean;
  prices: { pro?: number; elite?: number };
  currency: string;
  /** false for admin-granted plans */
  selfServe: boolean;
  paymentsEnabled: boolean;
  busyPlan: PlanKey | null;
  onSelect: (plan: PaidPlanKey) => void;
};

export function PlanCards(p: PlanCardsProps) {
  return (
    <div className="grid md:grid-cols-3 gap-4">
      {PLAN_COPY.map((tier) => {
        const isCurrent = tier.key === p.currentPlan;
        const price = tier.key === "free" ? 0 : p.prices[tier.key];
        const purchasable = tier.key !== "free" && price !== undefined;
        const isScheduled = p.scheduledPlan === tier.key;
        const busy = p.busyPlan === tier.key;

        let cta: string | null = null;
        if (purchasable && !isCurrent && p.selfServe) {
          if (!p.hasSubscription) cta = `Upgrade to ${tier.name}`;
          else if (PLAN_RANK[tier.key] > PLAN_RANK[p.currentPlan]) cta = `Upgrade to ${tier.name}`;
          else if (!isScheduled) cta = `Switch to ${tier.name} at renewal`;
        }

        return (
          <Card key={tier.key} className={cn("relative", tier.highlight && "border-primary border-2", isCurrent && "ring-2 ring-primary/40")}>
            {(isCurrent || isScheduled) && (
              <span className="absolute top-4 right-4 text-xs font-bold px-2.5 py-1 rounded-full bg-primary text-white">
                {isCurrent ? "Current" : `Starts ${formatDate(p.scheduledAt) ?? "at renewal"}`}
              </span>
            )}
            <CardHeader>
              <CardTitle className="text-base">{tier.name}</CardTitle>
              <p className="text-2xl font-extrabold">
                {tier.key === "free" ? formatMoney(0, p.currency) : purchasable ? `${formatMoney(price as number, p.currency)}/mo` : "Invite only"}
              </p>
              <CardDescription>{tier.key === "elite" && !purchasable ? "Assigned manually by an admin" : tier.tagline}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2.5">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0 mt-0.5" aria-hidden />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {cta && tier.key !== "free" && (
                <Button className="w-full mt-6" disabled={busy || p.busyPlan !== null || !p.paymentsEnabled} onClick={() => p.onSelect(tier.key as PaidPlanKey)}>
                  {busy ? "Working…" : cta}
                </Button>
              )}
              {cta && !p.paymentsEnabled && <p className="text-xs text-muted-foreground mt-2">Online payments aren&apos;t switched on yet.</p>}
              {isScheduled && !isCurrent && <p className="text-xs text-muted-foreground mt-4">Your plan will change to {PLAN_NAMES[tier.key]} when you renew.</p>}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
