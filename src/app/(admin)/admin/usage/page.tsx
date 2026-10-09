"use client";

import { useState } from "react";
import { Gauge } from "lucide-react";
import { api, useQuery } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { SkeletonBar } from "@/components/admin/shell/admin-skeleton";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { FilterChips } from "@/components/admin/billing/filters";
import { planLabel } from "@/components/admin/billing/format";
import { useKeepPrevious } from "@/components/admin/billing/hooks";
import { StatusDot } from "@/components/admin/billing/status-dot";
import {
  NUM,
  SkeletonRows,
  TableCard,
  Td,
  Th,
  type SkeletonCell,
} from "@/components/admin/billing/table-parts";
import { FilterBar } from "@/components/admin/shared/filter-bar";
import { LinkButton } from "@/components/admin/shared/link-button";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";

type PlanFilter = "all" | "free" | "pro" | "elite";
type LimitFilter = "all" | "at_limit";

const PLAN_OPTIONS: ReadonlyArray<{ value: PlanFilter; label: string }> = [
  { value: "all", label: "All plans" },
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "elite", label: "Elite" },
];

const LIMIT_OPTIONS: ReadonlyArray<{ value: LimitFilter; label: string }> = [
  { value: "all", label: "All users" },
  { value: "at_limit", label: "At a limit" },
];

const SKELETON_CELLS: SkeletonCell[] = [
  { w: "w-44", twoLine: true },
  { w: "w-12" },
  { w: "w-16", right: true },
  { w: "w-16", right: true },
  { w: "w-16", right: true },
  { w: "w-16", right: true },
  { w: "w-16" },
];

function formatLimit(limit: number) {
  return limit >= 999999 ? "∞" : String(limit);
}

export default function AdminUsagePage() {
  const [planFilter, setPlanFilter] = useState<PlanFilter>("all");
  const [limitFilter, setLimitFilter] = useState<LimitFilter>("all");

  // Filters and the "at limit" rule run in SQL; the summary cards come from a separate
  // aggregate so they stay correct when the table is capped.
  const result = useQuery(api.admin.usageLedger.getOverview, {
    limit: 500,
    ...(planFilter !== "all" ? { plan: planFilter } : {}),
    ...(limitFilter === "at_limit" ? { atLimit: true } : {}),
  });
  // Keep showing the last result while a new filter loads, so the table dims instead of collapsing.
  const { data: overview, stale } = useKeepPrevious(result);
  const summary = useQuery(api.admin.usageLedger.getSummary);

  const currentMonth = new Date().toISOString().slice(0, 7);

  const filtersActive = planFilter !== "all" || limitFilter !== "all";
  const resetFilters = () => {
    setPlanFilter("all");
    setLimitFilter("all");
  };

  return (
    <AdminPage
      title={`Usage: ${currentMonth}`}
      description={
        overview === undefined || summary === undefined
          ? "Monthly usage against plan limits."
          : `${overview.length} of ${summary.total} users shown`
      }
    >
      {/* Summary */}
      <section
        aria-label="Users by plan"
        className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4"
      >
        <SummaryTile label="Free users" value={summary?.free} />
        <SummaryTile label="Pro users" value={summary?.pro} />
        <SummaryTile label="Elite users" value={summary?.elite} />
        <SummaryTile label="At a plan limit" value={summary?.atLimit} />
      </section>

      <FilterBar onClear={filtersActive ? resetFilters : undefined}>
        <FilterChips
          label="Filter by plan"
          options={PLAN_OPTIONS}
          value={planFilter}
          onChange={setPlanFilter}
        />
        <FilterChips
          label="Filter by limit"
          options={LIMIT_OPTIONS}
          value={limitFilter}
          onChange={setLimitFilter}
        />
      </FilterBar>

      {/* Usage table */}
      <TableCard stale={stale}>
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th>User</Th>
              <Th>Plan</Th>
              <Th className="text-right">Uploads (used / limit)</Th>
              <Th className="text-right">Metadata (used / limit)</Th>
              <Th className="text-right">Veo (used / limit)</Th>
              <Th className="text-right">AI messages (used / limit)</Th>
              <Th>Status</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview === undefined ? (
              <SkeletonRows rows={8} cells={SKELETON_CELLS} />
            ) : (
              overview.map((row) => (
                <TableRow key={`${row.userId}-${row.month}`}>
                  <Td>
                    <p className="max-w-[260px] truncate font-medium">{row.name ?? row.email}</p>
                    {row.name ? (
                      <p className="max-w-[260px] truncate text-xs text-muted-foreground">
                        {row.email}
                      </p>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap font-medium">{planLabel(row.plan)}</Td>
                  <Td className={`${NUM} whitespace-nowrap`}>
                    {row.videosUploaded} / {formatLimit(row.limits.videosUploaded)}
                  </Td>
                  <Td className={`${NUM} whitespace-nowrap`}>
                    {row.metadataGenerated} / {formatLimit(row.limits.metadataGenerated)}
                  </Td>
                  <Td className={`${NUM} whitespace-nowrap`}>
                    {row.veoGenerated} / {formatLimit(row.limits.veoGenerated)}
                  </Td>
                  <Td className={`${NUM} whitespace-nowrap`}>
                    {row.aiMessagesUsed} / {formatLimit(row.limits.aiMessagesUsed)}
                  </Td>
                  <Td>
                    {row.atLimit ? (
                      <StatusDot tone="danger" label="At a limit" />
                    ) : (
                      <span className="text-muted-foreground">Within limits</span>
                    )}
                  </Td>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {overview !== undefined && overview.length === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={Gauge}
              title="No usage matches"
              description="No one matches these filters this month. Try a different plan or show all users."
              action={
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Gauge}
              title="No usage yet this month"
              description="Uploads, metadata, Veo and AI message counts appear here once users start using their plan."
              action={<LinkButton href="/admin/users">View users</LinkButton>}
            />
          )
        ) : null}
      </TableCard>
    </AdminPage>
  );
}

function SummaryTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="bg-card p-5">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      {value === undefined ? (
        <SkeletonBar className="mt-2 h-8 w-12" />
      ) : (
        <p className="mt-1 text-2xl font-semibold leading-tight tabular-nums">{value}</p>
      )}
    </div>
  );
}
