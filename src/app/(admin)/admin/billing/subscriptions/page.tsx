"use client";

import Link from "next/link";
import type { Route } from "next";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Repeat } from "lucide-react";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { TableSkeleton } from "@/components/admin/shell/admin-skeleton";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { FilterChips, SearchField } from "@/components/admin/billing/filters";
import { planLabel, planSourceLabel, userHref } from "@/components/admin/billing/format";
import { lastPageOffset, useDebounced, useKeepPrevious } from "@/components/admin/billing/hooks";
import { Pager } from "@/components/admin/billing/pager";
import { SubscriptionStatus } from "@/components/admin/billing/status-dot";
import { SkeletonRows, Td, TableCard, Th, type SkeletonCell } from "@/components/admin/billing/table-parts";
import { formatDate } from "@/components/billing/plans";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { api, useQuery } from "@/lib/rpc/client";

const PAGE_SIZE = 25;

type StatusFilter = "all" | "active" | "past_due" | "approval_pending" | "cancelled" | "expired";

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "past_due", label: "Past due" },
  { value: "approval_pending", label: "Awaiting payment" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

/** Statuses that /admin/billing/subscriptions?status=... may open on. Anything else is ignored. */
const LINKABLE_STATUSES: ReadonlyArray<StatusFilter> = ["active", "past_due", "approval_pending", "cancelled", "expired"];

function initialStatus(param: string | null): StatusFilter {
  return LINKABLE_STATUSES.find((s) => s === param) ?? "all";
}

const SUBSCRIPTIONS_DESCRIPTION = "Every customer subscription and how their plan was granted. Open a customer to change their plan.";

const SKELETON_CELLS: SkeletonCell[] = [{ w: "w-44", twoLine: true }, { w: "w-12" }, { w: "w-28", twoLine: true }, { w: "w-24", twoLine: true }, { w: "w-24", twoLine: true }];

export default function AdminSubscriptionsPage() {
  // useSearchParams needs a Suspense boundary; keep the page header stable while it resolves.
  return (
    <Suspense
      fallback={
        <AdminPage title="Subscriptions" description={SUBSCRIPTIONS_DESCRIPTION}>
          <TableCard>
            <TableSkeleton rows={8} cols={5} />
          </TableCard>
        </AdminPage>
      }
    >
      <SubscriptionsContent />
    </Suspense>
  );
}

function SubscriptionsContent() {
  // /admin/billing/subscriptions?status=past_due opens on that status (linked from the overview and billing pages).
  const initial = initialStatus(useSearchParams().get("status"));
  const [status, setStatus] = useState<StatusFilter>(initial);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);

  const term = useDebounced(search.trim(), 300);
  const result = useQuery(api.admin.billing.listSubscriptions, {
    ...(status !== "all" ? { status } : {}),
    ...(term ? { search: term } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const { data, stale } = useKeepPrevious(result);
  const total = data?.total;

  // The last page emptied out (rows changed underneath us): step back instead of showing nothing.
  if (total !== undefined && total > 0 && offset >= total) setOffset(lastPageOffset(total, PAGE_SIZE));

  const filtersActive = status !== "all" || search.trim() !== "";
  const resetFilters = () => {
    setStatus("all");
    setSearch("");
    setOffset(0);
  };

  return (
    <AdminPage title="Subscriptions" description={SUBSCRIPTIONS_DESCRIPTION}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <FilterChips
          label="Filter by status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setOffset(0);
          }}
        />
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          <SearchField
            value={search}
            onChange={(v) => {
              setSearch(v);
              setOffset(0);
            }}
          />
          {filtersActive ? (
            <button type="button" onClick={resetFilters} className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      <TableCard stale={stale}>
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th>Customer</Th>
              <Th>Plan</Th>
              <Th>Status</Th>
              <Th>Current period ends</Th>
              <Th>Account plan</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data === undefined ? (
              <SkeletonRows rows={8} cells={SKELETON_CELLS} />
            ) : (
              data.rows.map((s) => (
                <TableRow key={s._id}>
                  <Td>
                    <Link href={userHref(s.userId) as Route} className="block max-w-[260px] truncate underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {s.email}
                    </Link>
                    {s.name ? <p className="max-w-[260px] truncate text-xs text-muted-foreground">{s.name}</p> : null}
                  </Td>
                  <Td className="whitespace-nowrap font-medium">{planLabel(s.plan)}</Td>
                  <Td>
                    <SubscriptionStatus status={s.status} />
                    {s.cancelAtPeriodEnd ? <p className="text-xs text-muted-foreground">Cancels at period end</p> : null}
                    {s.pendingPlan ? <p className="text-xs text-muted-foreground">Switches to {planLabel(s.pendingPlan)} at renewal</p> : null}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {formatDate(s.periodEnd) ?? <span className="text-muted-foreground">—</span>}
                    {s.graceUntil ? <p className="text-xs text-muted-foreground">Grace until {formatDate(s.graceUntil)}</p> : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {planLabel(s.userPlan)}
                    <p className="text-xs text-muted-foreground">{planSourceLabel(s.planSource)}</p>
                  </Td>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {data !== undefined && data.total === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={Repeat}
              title="No subscriptions match"
              description="Nothing matches these filters. Try a different status or a shorter email."
              action={
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={Repeat} title="No subscriptions yet" description="Subscriptions appear here once a customer starts checkout for a paid plan." />
          )
        ) : null}

        <Pager total={total} offset={offset} pageSize={PAGE_SIZE} onOffsetChange={setOffset} className="border-t border-border" />
      </TableCard>
    </AdminPage>
  );
}
