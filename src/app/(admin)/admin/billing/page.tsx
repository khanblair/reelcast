"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState, type ReactNode } from "react";
import { ArrowRight, CircleCheck, Receipt } from "lucide-react";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { formatDateTime, type BillingPayment } from "@/components/admin/billing/format";
import { PaymentDetailSheet } from "@/components/admin/billing/payment-detail-sheet";
import { PaymentsTable } from "@/components/admin/billing/payments-table";
import { FlagStatus } from "@/components/admin/billing/status-dot";
import { NUM, SkeletonRows, Td, Th, type SkeletonCell } from "@/components/admin/billing/table-parts";
import { formatMoney } from "@/components/billing/plans";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { api, useQuery } from "@/lib/rpc/client";
import type { ReturnOf } from "@/lib/rpc/types";
import { cn } from "@/lib/utils";

const count = (n: number) => n.toLocaleString();

export default function AdminBillingOverviewPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const overview = useQuery(api.admin.billing.overview);
  const review = useQuery(api.admin.billing.listNeedsReview, { includeReviewed: false, limit: 5, offset: 0 });
  const recent = useQuery(api.admin.billing.listPayments, { filter: "all", limit: 10, offset: 0 });

  return (
    <AdminPage title="Billing" description="Subscriptions, revenue and the payments that need a human, at a glance.">
      <MetricStrip overview={overview} />

      {overview && overview.pendingPayments > 0 ? (
        <p className="-mt-2 text-sm text-muted-foreground">
          {count(overview.pendingPayments)} {overview.pendingPayments === 1 ? "order" : "orders"} sent to Pesapal in the last 7 days{" "}
          {overview.pendingPayments === 1 ? "hasn't" : "haven't"} completed yet.{" "}
          <Link href={"/admin/billing/payments" as Route} className="underline underline-offset-4 hover:text-foreground">
            See payments
          </Link>
        </p>
      ) : null}

      <Section
        id="needs-review-heading"
        title="Needs review"
        meta={review ? (review.total > 0 ? `${count(review.total)} open` : undefined) : undefined}
        href="/admin/billing/review"
        linkLabel="View all"
      >
        <ReviewPreview rows={review?.rows} onSelect={setSelectedId} />
      </Section>

      <Section id="recent-payments-heading" title="Recent payments" href="/admin/billing/payments" linkLabel="View all">
        {recent && recent.rows.length === 0 ? (
          <EmptyState icon={Receipt} title="No payments yet" description="Payments appear here as soon as a customer is sent to Pesapal to pay for a plan." />
        ) : (
          <PaymentsTable rows={recent?.rows} onSelect={setSelectedId} showMethod={false} skeletonRows={10} />
        )}
      </Section>

      <PaymentDetailSheet paymentId={selectedId} onClose={() => setSelectedId(null)} />
    </AdminPage>
  );
}

// ─── metric strip ────────────────────────────────────────────────────────────

type Overview = ReturnOf<typeof api.admin.billing.overview>;

function MetricStrip({ overview }: { overview: Overview | undefined }) {
  return (
    <section
      aria-label="Billing summary"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]"
    >
      {overview === undefined ? (
        <StripSkeleton />
      ) : (
        <>
          <div className="col-span-2 bg-[color-mix(in_srgb,var(--primary)_6%,var(--card))] p-5 lg:col-span-1">
            <p className="text-sm font-medium text-muted-foreground">Active subscriptions</p>
            <p className="mt-1 text-4xl font-semibold leading-tight tracking-tight tabular-nums">{count(overview.subscriptions.active)}</p>
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              {count(overview.subscriptions.cancelled)} cancelled, {count(overview.subscriptions.expired)} expired
            </p>
          </div>
          <Link
            href={"/admin/billing/subscriptions?status=past_due" as Route}
            className="block bg-card p-5 transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
          >
            <p className="text-sm font-medium text-muted-foreground">Past due</p>
            <p className="mt-1 text-2xl font-semibold leading-tight tabular-nums">{count(overview.subscriptions.pastDue)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Renewals not paid yet</p>
          </Link>
          <Metric label="Awaiting payment" value={count(overview.subscriptions.awaitingPayment)} note="Checkout not completed" />
          <div className="col-span-2 bg-card p-5 lg:col-span-1">
            <p className="text-sm font-medium text-muted-foreground">Revenue, last 30 days</p>
            {overview.revenue30d.length === 0 ? (
              <>
                <p className="mt-1 text-2xl font-semibold leading-tight tabular-nums text-muted-foreground">—</p>
                <p className="mt-1 text-xs text-muted-foreground">No completed payments</p>
              </>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {overview.revenue30d.map((r) => (
                  <li key={r.currency} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-2xl font-semibold leading-tight tabular-nums">{formatMoney(r.total, r.currency)}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {count(r.count)} {r.count === 1 ? "payment" : "payments"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Link
            href={"/admin/billing/review" as Route}
            className="col-span-2 block bg-card p-5 transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none lg:col-span-1"
          >
            <p className="text-sm font-medium text-muted-foreground">Needs review</p>
            <p className="mt-1 text-2xl font-semibold leading-tight tabular-nums">{count(overview.needsReviewCount)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{overview.needsReviewCount > 0 ? "Open the queue" : "All clear"}</p>
          </Link>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-card p-5">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold leading-tight tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function StripSkeleton() {
  return (
    <>
      <div className="col-span-2 bg-card p-5 lg:col-span-1" role="status" aria-label="Loading billing summary">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="mt-2 h-10 w-16" />
        <Skeleton className="mt-2 h-3 w-40" />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="bg-card p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-2 h-8 w-10" />
          <Skeleton className="mt-2 h-3 w-28" />
        </div>
      ))}
      <div className="col-span-2 bg-card p-5 lg:col-span-1">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="mt-2 h-8 w-28" />
        <Skeleton className="mt-2 h-3 w-24" />
      </div>
      <div className="col-span-2 bg-card p-5 lg:col-span-1">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-8 w-10" />
        <Skeleton className="mt-2 h-3 w-20" />
      </div>
    </>
  );
}

// ─── sections ────────────────────────────────────────────────────────────────

function Section({ id, title, meta, href, linkLabel, children }: { id: string; title: string; meta?: string; href: string; linkLabel: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <h2 id={id} className="text-sm font-semibold">
          {title}
          {meta ? <span className="ml-2 font-normal tabular-nums text-muted-foreground">{meta}</span> : null}
        </h2>
        <Link
          href={href as Route}
          className={cn("inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none")}
        >
          {linkLabel}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </div>
      {children}
    </section>
  );
}

const REVIEW_SKELETON: SkeletonCell[] = [{ w: "w-32" }, { w: "w-44" }, { w: "w-28" }, { w: "w-16", right: true }];

function ReviewPreview({ rows, onSelect }: { rows: BillingPayment[] | undefined; onSelect: (id: string) => void }) {
  if (rows && rows.length === 0) {
    return (
      <EmptyState
        icon={CircleCheck}
        title="Nothing to review"
        description="Payments that don't match their order, upgrades paid too late and reversals will show up here."
      />
    );
  }
  return (
    <Table className="min-w-[640px]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <Th>Date</Th>
          <Th>Customer</Th>
          <Th>Issue</Th>
          <Th className="text-right">Amount</Th>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows === undefined ? (
          <SkeletonRows rows={5} cells={REVIEW_SKELETON} />
        ) : (
          rows.map((p) => {
            const date = formatDateTime(p.createdAt) ?? "—";
            return (
              <TableRow key={p._id} onClick={() => onSelect(p._id)} className="cursor-pointer">
                <Td className="whitespace-nowrap">
                  <button
                    type="button"
                    aria-label={`Open payment details, ${date}`}
                    className="rounded-sm text-left tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {date}
                  </button>
                </Td>
                <Td>
                  <p className="max-w-[260px] truncate">{p.email}</p>
                </Td>
                <Td>
                  <FlagStatus payment={p} />
                </Td>
                <Td className={`${NUM} whitespace-nowrap font-medium`}>{formatMoney(p.amount, p.currency)}</Td>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
