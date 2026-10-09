"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState, useMemo } from "react";
import { Users } from "lucide-react";
import { api, useQuery } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { FilterChips, SearchField } from "@/components/admin/billing/filters";
import { planLabel } from "@/components/admin/billing/format";
import { lastPageOffset, useDebounced, useKeepPrevious } from "@/components/admin/billing/hooks";
import { Pager } from "@/components/admin/billing/pager";
import { StatusDot } from "@/components/admin/billing/status-dot";
import {
  SkeletonRows,
  TableCard,
  Td,
  Th,
  type SkeletonCell,
} from "@/components/admin/billing/table-parts";
import { FilterBar } from "@/components/admin/shared/filter-bar";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";

type PlanFilter = "all" | "free" | "pro" | "elite";
type YouTubeFilter = "all" | "connected" | "not_connected";

const PAGE_SIZE = 20;

const PLAN_OPTIONS: ReadonlyArray<{ value: PlanFilter; label: string }> = [
  { value: "all", label: "All plans" },
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "elite", label: "Elite" },
];

const YOUTUBE_OPTIONS: ReadonlyArray<{ value: YouTubeFilter; label: string }> = [
  { value: "all", label: "Any YouTube" },
  { value: "connected", label: "Connected" },
  { value: "not_connected", label: "Not connected" },
];

const SKELETON_CELLS: SkeletonCell[] = [
  { w: "w-44", twoLine: true },
  { w: "w-12" },
  { w: "w-24" },
  { w: "w-16" },
  { w: "w-14" },
];

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<PlanFilter>("all");
  const [ytFilter, setYtFilter] = useState<YouTubeFilter>("all");
  const [page, setPage] = useState(1);

  // Search and plan are applied in SQL (so they work beyond the row cap); the YouTube filter
  // narrows the returned rows client-side.
  const serverSearch = useDebounced(search.trim(), 300);
  const result = useQuery(api.admin.users.listAll, {
    ...(serverSearch ? { search: serverSearch } : {}),
    ...(planFilter !== "all" ? { plan: planFilter } : {}),
  });
  // Keep showing the last result while a new search or plan loads, so the table dims instead of collapsing.
  const { data: users, stale } = useKeepPrevious(result);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = search.toLowerCase().trim();
    return users.filter((u) => {
      if (q && !u.name?.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q))
        return false;
      if (planFilter !== "all" && (u.plan ?? "free") !== planFilter) return false;
      if (ytFilter === "connected" && !u.youtubeConnected) return false;
      if (ytFilter === "not_connected" && u.youtubeConnected) return false;
      return true;
    });
  }, [users, search, planFilter, ytFilter]);

  const total = users === undefined ? undefined : filtered.length;

  // The list shrank underneath us (rows changed): step back instead of showing an empty page.
  if (total !== undefined && total > 0 && (page - 1) * PAGE_SIZE >= total) {
    setPage(lastPageOffset(total, PAGE_SIZE) / PAGE_SIZE + 1);
  }

  const offset = (page - 1) * PAGE_SIZE;
  const paginated = filtered.slice(offset, offset + PAGE_SIZE);

  // Reset to page 1 when filters change
  const updateSearch = (v: string) => {
    setSearch(v);
    setPage(1);
  };
  const updatePlan = (v: PlanFilter) => {
    setPlanFilter(v);
    setPage(1);
  };
  const updateYt = (v: YouTubeFilter) => {
    setYtFilter(v);
    setPage(1);
  };

  const filtersActive = search.trim() !== "" || planFilter !== "all" || ytFilter !== "all";
  const resetFilters = () => {
    setSearch("");
    setPlanFilter("all");
    setYtFilter("all");
    setPage(1);
  };

  return (
    <AdminPage
      title="Users"
      description={
        users === undefined
          ? "Every account on the platform."
          : `${filtered.length} of ${users.length} accounts`
      }
    >
      <FilterBar
        onClear={filtersActive ? resetFilters : undefined}
        search={
          <SearchField value={search} onChange={updateSearch} placeholder="Search name or email" />
        }
      >
        <FilterChips
          label="Filter by plan"
          options={PLAN_OPTIONS}
          value={planFilter}
          onChange={updatePlan}
        />
        <FilterChips
          label="Filter by YouTube connection"
          options={YOUTUBE_OPTIONS}
          value={ytFilter}
          onChange={updateYt}
        />
      </FilterBar>

      <TableCard stale={stale}>
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th>Name and email</Th>
              <Th>Plan</Th>
              <Th>YouTube</Th>
              <Th>Auto-publish</Th>
              <Th>Resend key</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users === undefined ? (
              <SkeletonRows rows={8} cells={SKELETON_CELLS} />
            ) : (
              paginated.map((user) => (
                <TableRow key={user._id}>
                  <Td>
                    <Link
                      href={`/admin/users/${user._id}` as Route}
                      className="block max-w-[260px] truncate font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {user.name ?? user.email}
                    </Link>
                    <p className="max-w-[260px] truncate text-xs text-muted-foreground">
                      {user.name ? user.email : null}
                      {user.name && user.isAdmin ? " · " : null}
                      {user.isAdmin ? (
                        <span className="font-medium text-foreground">Admin</span>
                      ) : null}
                    </p>
                  </Td>
                  <Td className="whitespace-nowrap font-medium">{planLabel(user.plan)}</Td>
                  <Td>
                    <StatusDot
                      tone={user.youtubeConnected ? "success" : "neutral"}
                      label={user.youtubeConnected ? "Connected" : "Not connected"}
                    />
                  </Td>
                  <Td>
                    <StatusDot
                      tone={user.autoPublishEnabled ? "success" : "neutral"}
                      label={user.autoPublishEnabled ? "On" : "Off"}
                    />
                  </Td>
                  <Td className="text-muted-foreground">{user.hasResendApiKey ? "Set" : "—"}</Td>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {users !== undefined && filtered.length === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={Users}
              title="No users match"
              description="Nothing matches these filters. Try a different plan or a shorter name or email."
              action={
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Users}
              title="No users yet"
              description="Accounts appear here as soon as someone signs up for ReelCast."
            />
          )
        ) : null}

        <Pager
          total={total}
          offset={offset}
          pageSize={PAGE_SIZE}
          onOffsetChange={(o) => setPage(o / PAGE_SIZE + 1)}
          className="border-t border-border"
        />
      </TableCard>
    </AdminPage>
  );
}
