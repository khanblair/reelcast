"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { Receipt } from "lucide-react";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { FilterChips, SearchField } from "@/components/admin/billing/filters";
import { lastPageOffset, useDebounced, useKeepPrevious } from "@/components/admin/billing/hooks";
import { Pager } from "@/components/admin/billing/pager";
import { PaymentDetailSheet } from "@/components/admin/billing/payment-detail-sheet";
import { PaymentsTable } from "@/components/admin/billing/payments-table";
import { TableCard } from "@/components/admin/billing/table-parts";
import { Button } from "@/components/ui/button";
import { api, useQuery } from "@/lib/rpc/client";

const PAGE_SIZE = 25;

type PaymentFilter = "all" | "completed" | "pending" | "failed" | "reversed";

const FILTER_OPTIONS: ReadonlyArray<{ value: PaymentFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "completed", label: "Completed" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "reversed", label: "Reversed" },
];

export default function AdminPaymentsPage() {
  const [filter, setFilter] = useState<PaymentFilter>("all");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const term = useDebounced(search.trim(), 300);
  const result = useQuery(api.admin.billing.listPayments, {
    filter,
    ...(term ? { search: term } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const { data, stale } = useKeepPrevious(result);
  const total = data?.total;

  if (total !== undefined && total > 0 && offset >= total) setOffset(lastPageOffset(total, PAGE_SIZE));

  const filtersActive = filter !== "all" || search.trim() !== "";
  const resetFilters = () => {
    setFilter("all");
    setSearch("");
    setOffset(0);
  };

  return (
    <AdminPage title="Payments" description="Every payment attempt, newest first. Select a row to see its references and what Pesapal told us.">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <FilterChips
          label="Filter by payment status"
          options={FILTER_OPTIONS}
          value={filter}
          onChange={(v) => {
            setFilter(v);
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
        <PaymentsTable rows={data?.rows} onSelect={setSelectedId} />

        {data !== undefined && data.total === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={Receipt}
              title="No payments match"
              description="Nothing matches these filters. Try a different status or a shorter email."
              action={
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Receipt}
              title="No payments yet"
              description="Payments appear here as soon as a customer is sent to Pesapal to pay for a plan."
              action={
                <Link href={"/admin/billing/subscriptions" as Route} className="text-sm underline underline-offset-4 hover:text-foreground">
                  View subscriptions
                </Link>
              }
            />
          )
        ) : null}

        <Pager total={total} offset={offset} pageSize={PAGE_SIZE} onOffsetChange={setOffset} className="border-t border-border" />
      </TableCard>

      <PaymentDetailSheet paymentId={selectedId} onClose={() => setSelectedId(null)} />
    </AdminPage>
  );
}
