"use client";

import { Gauge } from "lucide-react";
import { api, useQuery } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { SkeletonBar } from "@/components/admin/shell/admin-skeleton";
import { EmptyState } from "@/components/admin/billing/empty-state";
import {
  NUM,
  SkeletonRows,
  TableCard,
  Td,
  Th,
  type SkeletonCell,
} from "@/components/admin/billing/table-parts";
import { LinkButton } from "@/components/admin/shared/link-button";
import { Meter, quotaTone } from "@/components/admin/shared/meter";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";

const DAILY_LIMIT = 10_000;

const SKELETON_CELLS: SkeletonCell[] = [
  { w: "w-6", right: true },
  { w: "w-56" },
  { w: "w-14", right: true },
  { w: "w-40" },
];

export default function AdminQuotaPage() {
  const overview = useQuery(api.admin.quota.getQuotaOverview);

  const totalUsed = overview?.reduce((s, r) => s + r.unitsUsed, 0) ?? 0;
  const totalPct = Math.min(100, Math.round((totalUsed / DAILY_LIMIT) * 100));

  return (
    <AdminPage
      title="YouTube API quota"
      description={`Usage today. Daily limit: ${DAILY_LIMIT.toLocaleString()} units.`}
    >
      {/* Total progress */}
      <section
        aria-label="Total quota used"
        className="rounded-lg border border-border bg-card p-5"
      >
        <p className="text-sm font-medium text-muted-foreground">Total used today</p>
        {overview === undefined ? (
          <div role="status" aria-busy="true" className="mt-2 space-y-3">
            <span className="sr-only">Loading…</span>
            <SkeletonBar className="h-8 w-56" />
            <SkeletonBar className="h-1.5 w-full" />
          </div>
        ) : (
          <>
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums">
              <span className="text-3xl font-semibold leading-tight tracking-tight">
                {totalUsed.toLocaleString()}
              </span>
              <span className="text-sm text-muted-foreground">
                of {DAILY_LIMIT.toLocaleString()} units ({totalPct}%)
              </span>
            </p>
            <Meter
              value={totalPct}
              tone={quotaTone(totalPct)}
              label="Share of the daily YouTube quota used"
              className="mt-3 h-2"
            />
          </>
        )}
      </section>

      {/* Per-user table */}
      <TableCard>
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th className="w-16 text-right">Rank</Th>
              <Th>Email</Th>
              <Th className="text-right">Units used</Th>
              <Th>Share of daily quota</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overview === undefined ? (
              <SkeletonRows rows={6} cells={SKELETON_CELLS} />
            ) : (
              overview.map((row, i) => {
                const pct = Math.min(100, Math.round((row.unitsUsed / DAILY_LIMIT) * 100));
                return (
                  <TableRow key={row.userId}>
                    <Td className={`${NUM} text-muted-foreground`}>{i + 1}</Td>
                    <Td className="max-w-[320px] truncate">{row.email}</Td>
                    <Td className={`${NUM} whitespace-nowrap`}>{row.unitsUsed.toLocaleString()}</Td>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Meter
                          value={pct}
                          tone={quotaTone(pct)}
                          label={`${row.email} quota used`}
                          className="w-32"
                        />
                        <span className="w-10 text-xs tabular-nums text-muted-foreground">
                          {pct}%
                        </span>
                      </div>
                    </Td>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        {overview !== undefined && overview.length === 0 ? (
          <EmptyState
            icon={Gauge}
            title="No quota consumed today"
            description="YouTube API units show up here, highest first, as users publish and sync with YouTube."
            action={<LinkButton href="/admin/jobs">See recent jobs</LinkButton>}
          />
        ) : null}
      </TableCard>
    </AdminPage>
  );
}
