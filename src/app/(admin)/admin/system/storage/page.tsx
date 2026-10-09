"use client";

import { HardDrive } from "lucide-react";
import { api, useQuery } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { SkeletonBar } from "@/components/admin/shell/admin-skeleton";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { planLabel } from "@/components/admin/billing/format";
import {
  NUM,
  SkeletonRows,
  Td,
  Th,
  type SkeletonCell,
} from "@/components/admin/billing/table-parts";
import { LinkButton } from "@/components/admin/shared/link-button";
import { formatBytes } from "@/components/admin/shared/format";
import { Meter } from "@/components/admin/shared/meter";
import { SectionCard } from "@/components/admin/shared/section-card";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";

const SKELETON_CELLS: SkeletonCell[] = [
  { w: "w-6", right: true },
  { w: "w-44", twoLine: true },
  { w: "w-12" },
  { w: "w-8", right: true },
  { w: "w-16", right: true },
  { w: "w-40" },
];

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function AdminStoragePage() {
  const breakdown = useQuery(api.admin.storage.getPerUserBreakdown);

  const totalBytes = breakdown?.reduce((s, r) => s + r.totalBytes, 0) ?? 0;
  const totalVideos = breakdown?.reduce((s, r) => s + r.videoCount, 0) ?? 0;

  return (
    <AdminPage
      title="Storage"
      description="Platform-wide file storage consumed by uploaded videos."
    >
      {/* Total storage */}
      <section aria-label="Total storage" className="rounded-lg border border-border bg-card p-5">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <HardDrive aria-hidden className="size-4" />
          Total storage
        </p>
        {breakdown === undefined ? (
          <div role="status" aria-busy="true" className="mt-2 space-y-2">
            <span className="sr-only">Loading…</span>
            <SkeletonBar className="h-9 w-32" />
            <SkeletonBar className="h-4 w-64" />
          </div>
        ) : (
          <>
            <p className="mt-1 text-4xl font-semibold leading-tight tracking-tight tabular-nums">
              {formatBytes(totalBytes)}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Across {plural(totalVideos, "video")} from {plural(breakdown.length, "user")}. Summed
              across all videos currently stored on the platform.
            </p>
          </>
        )}
      </section>

      {/* Per-user breakdown */}
      <SectionCard title="Per-user breakdown" description="Sorted by storage usage, highest first.">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th className="w-16 text-right">Rank</Th>
              <Th>User</Th>
              <Th>Plan</Th>
              <Th className="text-right">Videos</Th>
              <Th className="text-right">Storage</Th>
              <Th>Share of total</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {breakdown === undefined ? (
              <SkeletonRows rows={6} cells={SKELETON_CELLS} />
            ) : (
              breakdown.map((row, i) => {
                const pct =
                  totalBytes > 0
                    ? Math.min(100, Math.round((row.totalBytes / totalBytes) * 100))
                    : 0;
                return (
                  <TableRow key={row.userId}>
                    <Td className={`${NUM} text-muted-foreground`}>{i + 1}</Td>
                    <Td>
                      <p className="max-w-[260px] truncate font-medium">{row.name ?? row.email}</p>
                      {row.name ? (
                        <p className="max-w-[260px] truncate text-xs text-muted-foreground">
                          {row.email}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap font-medium">{planLabel(row.plan)}</Td>
                    <Td className={NUM}>{row.videoCount.toLocaleString()}</Td>
                    <Td className={`${NUM} whitespace-nowrap`}>{formatBytes(row.totalBytes)}</Td>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Meter
                          value={pct}
                          label={`${row.email} share of total storage`}
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

        {breakdown !== undefined && breakdown.length === 0 ? (
          <EmptyState
            icon={HardDrive}
            title="No storage in use"
            description="Storage per user appears here once videos are uploaded."
            action={<LinkButton href="/admin/videos">View videos</LinkButton>}
          />
        ) : null}
      </SectionCard>
    </AdminPage>
  );
}
