"use client";

import { useState, useMemo } from "react";
import { Trash2, ExternalLink, Film } from "lucide-react";
import { api, useQuery, useMutation } from "@/lib/rpc/client";
import type { Id } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { FilterChips, SearchField } from "@/components/admin/billing/filters";
import { lastPageOffset, useDebounced, useKeepPrevious } from "@/components/admin/billing/hooks";
import { Pager } from "@/components/admin/billing/pager";
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
import { formatBytes } from "@/components/admin/shared/format";
import { videoStatus } from "@/components/admin/shared/status";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTimeEAT } from "@/lib/eat";

type StatusFilter = "all" | "draft" | "ready" | "scheduled" | "published" | "failed";

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "failed", label: "Failed" },
];

const PAGE_SIZE = 20;

type Video = {
  _id: string;
  title?: string | null;
  status: string;
  userId: string;
  userEmail?: string | null;
  userName?: string | null;
  rawFileSize?: number | null;
  publishedAt?: number | null;
  scheduledPublishAt?: number | null;
  publishedVideoId?: string | null;
};

const SKELETON_CELLS: SkeletonCell[] = [
  { w: "w-44" },
  { w: "w-32" },
  { w: "w-20" },
  { w: "w-14", right: true },
  { w: "w-32" },
  { w: "w-16", right: true },
];

const ICON_ACTION =
  "inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

export default function AdminVideosPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // Status and search are applied in SQL (so they work beyond the row cap).
  const serverSearch = useDebounced(search.trim(), 300);
  const result = useQuery(api.admin.videos.listAll, {
    limit: 200,
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(serverSearch ? { search: serverSearch } : {}),
  });
  // Keep showing the last result while a new search or status loads, so the table dims instead of collapsing.
  const { data: videos, stale } = useKeepPrevious(result);
  const adminDelete = useMutation(api.admin.videos.adminDelete);

  const filtered = useMemo(() => {
    if (!videos) return [];
    const q = search.toLowerCase().trim();
    return (videos as Video[]).filter((v) => {
      if (statusFilter !== "all" && v.status !== statusFilter) return false;
      if (q) {
        const titleMatch = v.title?.toLowerCase().includes(q);
        const userMatch =
          v.userName?.toLowerCase().includes(q) || v.userEmail?.toLowerCase().includes(q);
        if (!titleMatch && !userMatch) return false;
      }
      return true;
    });
  }, [videos, statusFilter, search]);

  const total = videos === undefined ? undefined : filtered.length;

  // The list shrank underneath us (a video was deleted): step back instead of showing an empty page.
  if (total !== undefined && total > 0 && (page - 1) * PAGE_SIZE >= total) {
    setPage(lastPageOffset(total, PAGE_SIZE) / PAGE_SIZE + 1);
  }

  const offset = (page - 1) * PAGE_SIZE;
  const paginated = filtered.slice(offset, offset + PAGE_SIZE);

  const updateSearch = (v: string) => {
    setSearch(v);
    setPage(1);
  };
  const updateStatus = (s: StatusFilter) => {
    setStatusFilter(s);
    setPage(1);
  };

  const filtersActive = statusFilter !== "all" || search.trim() !== "";
  const resetFilters = () => {
    setStatusFilter("all");
    setSearch("");
    setPage(1);
  };

  async function handleDelete(videoId: string) {
    if (!window.confirm("Delete this video?")) return;
    try {
      await adminDelete({ videoId: videoId as Id });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to delete the video.");
    }
  }

  return (
    <AdminPage
      title="Videos"
      description={
        videos !== undefined
          ? `${filtered.length} of ${videos.length} videos`
          : "All videos across all users."
      }
    >
      <FilterBar
        onClear={filtersActive ? resetFilters : undefined}
        search={
          <SearchField value={search} onChange={updateSearch} placeholder="Search title or user" />
        }
      >
        <FilterChips
          label="Filter by video status"
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={updateStatus}
        />
      </FilterBar>

      <TableCard stale={stale}>
        <Table className="min-w-[880px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <Th>Title</Th>
              <Th>User</Th>
              <Th>Status</Th>
              <Th className="text-right">Size</Th>
              <Th>Published or scheduled</Th>
              <Th className="text-right">Actions</Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {videos === undefined ? (
              <SkeletonRows rows={8} cells={SKELETON_CELLS} />
            ) : (
              paginated.map((video) => {
                const status = videoStatus(video.status);
                const title = video.title ?? "Untitled";
                return (
                  <TableRow key={video._id}>
                    <Td className="max-w-[240px] truncate" title={title}>
                      {title}
                    </Td>
                    <Td className="max-w-[200px] truncate text-muted-foreground">
                      {video.userName ?? video.userEmail ?? "—"}
                    </Td>
                    <Td>
                      <StatusDot tone={status.tone} label={status.label} />
                    </Td>
                    <Td className={`${NUM} whitespace-nowrap text-muted-foreground`}>
                      {formatBytes(video.rawFileSize, "—")}
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {video.publishedAt
                        ? formatDateTimeEAT(video.publishedAt)
                        : video.scheduledPublishAt
                          ? formatDateTimeEAT(video.scheduledPublishAt)
                          : "—"}
                    </Td>
                    <Td>
                      <div className="flex items-center justify-end gap-1">
                        {video.publishedVideoId ? (
                          <a
                            href={`https://youtube.com/watch?v=${video.publishedVideoId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${title} on YouTube`}
                            title="Open on YouTube"
                            className={`${ICON_ACTION} text-muted-foreground hover:bg-accent hover:text-foreground`}
                          >
                            <ExternalLink aria-hidden className="size-4" />
                          </a>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`Delete ${title}`}
                          title="Delete video"
                          onClick={() => handleDelete(video._id)}
                          className={`${ICON_ACTION} text-destructive hover:bg-destructive/10`}
                        >
                          <Trash2 aria-hidden className="size-4" />
                        </button>
                      </div>
                    </Td>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>

        {videos !== undefined && filtered.length === 0 ? (
          filtersActive ? (
            <EmptyState
              icon={Film}
              title="No videos match"
              description="Nothing matches these filters. Try a different status or a shorter title or user."
              action={
                <Button variant="outline" size="sm" onClick={resetFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Film}
              title="No videos yet"
              description="Videos appear here once users upload or generate them."
              action={<LinkButton href="/admin/users">View users</LinkButton>}
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
