"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Briefcase, CircleCheck } from "lucide-react";
import { api, useQuery } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { TableSkeleton } from "@/components/admin/shell/admin-skeleton";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { FilterChips } from "@/components/admin/billing/filters";
import { lastPageOffset } from "@/components/admin/billing/hooks";
import { Pager } from "@/components/admin/billing/pager";
import { StatusDot } from "@/components/admin/billing/status-dot";
import {
  SkeletonRows,
  TableCard,
  Td,
  Th,
  type SkeletonCell,
} from "@/components/admin/billing/table-parts";
import { LinkButton } from "@/components/admin/shared/link-button";
import { jobStatus, jobTypeLabel } from "@/components/admin/shared/status";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTimeEAT } from "@/lib/eat";

type Tab = "recent" | "failed";

const PAGE_SIZE = 20;

const TAB_OPTIONS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "recent", label: "Recent" },
  { value: "failed", label: "Failed" },
];

type Job = {
  _id: string;
  type: string;
  status: string;
  error?: string | null;
  startedAt?: number | null;
  completedAt?: number | null;
  userEmail?: string | null;
  videoTitle?: string | null;
};

const SKELETON_CELLS: SkeletonCell[] = [
  { w: "w-20" },
  { w: "w-36" },
  { w: "w-36" },
  { w: "w-20" },
  { w: "w-40" },
  { w: "w-32" },
];

function JobsHead() {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <Th>Type</Th>
        <Th>Video</Th>
        <Th>User</Th>
        <Th>Status</Th>
        <Th>Error</Th>
        <Th>Started</Th>
      </TableRow>
    </TableHeader>
  );
}

function JobsTable({
  jobs,
  tab,
  page,
  setPage,
  onShowRecent,
}: {
  jobs: Job[] | undefined;
  tab: Tab;
  page: number;
  setPage: (p: number) => void;
  onShowRecent: () => void;
}) {
  const total = jobs?.length;
  const offset = (page - 1) * PAGE_SIZE;
  const paginated = jobs?.slice(offset, offset + PAGE_SIZE);

  return (
    <TableCard>
      <Table className="min-w-[860px]">
        <JobsHead />
        <TableBody>
          {paginated === undefined ? (
            <SkeletonRows rows={8} cells={SKELETON_CELLS} />
          ) : (
            paginated.map((job) => {
              const status = jobStatus(job.status);
              return (
                <TableRow key={job._id}>
                  <Td className="whitespace-nowrap">{jobTypeLabel(job.type)}</Td>
                  <Td className="max-w-[200px] truncate">{job.videoTitle ?? "—"}</Td>
                  <Td className="max-w-[200px] truncate text-muted-foreground">
                    {job.userEmail ?? "—"}
                  </Td>
                  <Td>
                    <StatusDot tone={status.tone} label={status.label} />
                  </Td>
                  <Td
                    className="max-w-[260px] truncate text-muted-foreground"
                    title={job.error ?? undefined}
                  >
                    {job.error ? job.error.slice(0, 50) : "—"}
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                    {job.startedAt ? formatDateTimeEAT(job.startedAt) : "—"}
                  </Td>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {jobs !== undefined && jobs.length === 0 ? (
        tab === "failed" ? (
          <EmptyState
            icon={CircleCheck}
            title="No failed jobs"
            description="Publish and generation jobs that fail will show up here so you can follow up."
            action={
              <Button variant="outline" size="sm" onClick={onShowRecent}>
                Show recent jobs
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Briefcase}
            title="No jobs yet"
            description="Jobs appear here when a video is published or generated."
            action={<LinkButton href="/admin/videos">View videos</LinkButton>}
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
  );
}

const JOBS_DESCRIPTION = "Monitor publish and generation jobs across all users.";

export default function AdminJobsPage() {
  // useSearchParams needs a Suspense boundary; keep the page header stable while it resolves.
  return (
    <Suspense
      fallback={
        <AdminPage title="Jobs" description={JOBS_DESCRIPTION}>
          <TableCard>
            <TableSkeleton rows={8} cols={6} />
          </TableCard>
        </AdminPage>
      }
    >
      <JobsContent />
    </Suspense>
  );
}

function JobsContent() {
  // /admin/jobs?tab=failed opens on the failed tab (linked from the overview's "Needs attention").
  const initialTab: Tab = useSearchParams().get("tab") === "failed" ? "failed" : "recent";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [page, setPage] = useState(1);

  const recentJobs = useQuery(api.admin.jobs.listRecent, { limit: 50 });
  const failedJobs = useQuery(api.admin.jobs.listFailed, { limit: 50 });

  const jobs = tab === "recent" ? recentJobs : failedJobs;

  // The list shrank underneath us (it refreshes in the background): step back instead of showing an empty page.
  if (jobs !== undefined && jobs.length > 0 && (page - 1) * PAGE_SIZE >= jobs.length) {
    setPage(lastPageOffset(jobs.length, PAGE_SIZE) / PAGE_SIZE + 1);
  }

  const switchTab = (t: Tab) => {
    setTab(t);
    setPage(1);
  };

  return (
    <AdminPage title="Jobs" description={JOBS_DESCRIPTION}>
      <FilterChips label="Show jobs" options={TAB_OPTIONS} value={tab} onChange={switchTab} />

      <JobsTable
        jobs={jobs as Job[] | undefined}
        tab={tab}
        page={page}
        setPage={setPage}
        onShowRecent={() => switchTab("recent")}
      />
    </AdminPage>
  );
}
