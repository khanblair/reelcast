"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { CreditCard } from "lucide-react";
import { formatDate, formatMoney } from "@/components/billing/plans";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { api, useQuery } from "@/lib/rpc/client";
import type { ReturnOf } from "@/lib/rpc/types";
import { EmptyState } from "./empty-state";
import { formatDateTime, paymentTitle, planLabel, subscriptionStatus } from "./format";
import { PaymentDetailSheet } from "./payment-detail-sheet";
import { FlagMarker, PaymentStatus, SubscriptionStatus } from "./status-dot";
import { NUM, SkeletonRows, Td, Th, type SkeletonCell } from "./table-parts";

type UserSubscription = ReturnOf<typeof api.admin.billing.forUser>["subscriptions"][number];

const SKELETON_CELLS: SkeletonCell[] = [{ w: "w-32" }, { w: "w-28" }, { w: "w-16", right: true }, { w: "w-24" }];

/**
 * Billing card for the admin user page: the current (or last) subscription and the 10 latest payments.
 * Payment rows open the same detail panel as the payments page.
 */
export function UserBillingCard({ userId }: { userId: string }) {
  const billing = useQuery(api.admin.billing.forUser, { userId });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [current, ...earlier] = billing?.subscriptions ?? [];
  const empty = billing !== undefined && billing.subscriptions.length === 0 && billing.payments.length === 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 className="text-sm font-semibold">Billing</h2>
        <Link href={"/admin/billing/payments" as Route} className="rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none">
          All payments
        </Link>
      </div>

      {billing === undefined ? (
        <CardSkeleton />
      ) : empty ? (
        <EmptyState icon={CreditCard} title="No billing history" description="This user hasn't started a subscription or made a payment." />
      ) : (
        <>
          {current ? <SubscriptionSummary sub={current} earlier={earlier} /> : null}
          {billing.payments.length > 0 ? (
            <div className={current ? "border-t border-border" : undefined}>
              <p className="px-4 pb-1 pt-3 text-xs text-muted-foreground">Latest payments</p>
              <Table className="min-w-[560px]">
                <PaymentsHead />
                <TableBody>
                  {billing.payments.map((p) => {
                    const date = formatDateTime(p.createdAt) ?? "—";
                    return (
                      <TableRow key={p._id} onClick={() => setSelectedId(p._id)} className="cursor-pointer">
                        <Td className="whitespace-nowrap">
                          <button
                            type="button"
                            aria-label={`Open payment details, ${date}`}
                            className="rounded-sm text-left tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {date}
                          </button>
                        </Td>
                        <Td className="whitespace-nowrap">{paymentTitle(p)}</Td>
                        <Td className={`${NUM} whitespace-nowrap font-medium`}>{formatMoney(p.amount, p.currency)}</Td>
                        <Td>
                          <PaymentStatus payment={p} />
                          {p.flag ? <FlagMarker payment={p} className="mt-0.5 flex" /> : null}
                        </Td>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="border-t border-border px-4 py-4 text-sm text-muted-foreground">No payments yet.</p>
          )}
        </>
      )}

      <PaymentDetailSheet paymentId={selectedId} onClose={() => setSelectedId(null)} />
    </Card>
  );
}

function SubscriptionSummary({ sub, earlier }: { sub: UserSubscription; earlier: UserSubscription[] }) {
  return (
    <div className="space-y-2 px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-base font-semibold">{planLabel(sub.plan)}</p>
        <p className="text-sm">
          <SubscriptionStatus status={sub.status} />
        </p>
      </div>
      <p className="text-sm tabular-nums text-muted-foreground">
        {sub.periodEnd ? `Current period ends ${formatDate(sub.periodEnd)}` : "No billing period yet"}
        {sub.graceUntil ? ` · Grace until ${formatDate(sub.graceUntil)}` : ""}
      </p>
      {sub.cancelAtPeriodEnd ? <p className="text-sm text-muted-foreground">Cancels at period end.</p> : null}
      {sub.pendingPlan ? <p className="text-sm text-muted-foreground">Switches to {planLabel(sub.pendingPlan)} at renewal.</p> : null}
      {earlier.length > 0 ? (
        <p className="pt-1 text-xs text-muted-foreground">
          Earlier: {earlier.map((e) => `${planLabel(e.plan)} (${subscriptionStatus(e.status).label.toLowerCase()})`).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function PaymentsHead() {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <Th>Date</Th>
        <Th>Payment</Th>
        <Th className="text-right">Amount</Th>
        <Th>Status</Th>
      </TableRow>
    </TableHeader>
  );
}

function CardSkeleton() {
  return (
    <div role="status" aria-label="Loading billing">
      <div className="space-y-2 px-4 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="border-t border-border">
        <Skeleton className="mx-4 mb-1 mt-3 h-3 w-24" />
        <Table className="min-w-[560px]">
          <PaymentsHead />
          <TableBody>
            <SkeletonRows rows={4} cells={SKELETON_CELLS} />
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
