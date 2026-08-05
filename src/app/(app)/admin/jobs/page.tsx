"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTimeEAT } from "@/lib/eat";
import { CheckCircle, XCircle, Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Tab = "recent" | "failed";

function StatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle className="h-4 w-4 text-green-500" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-red-500" />;
  if (status === "processing") return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
  return <Clock className="h-4 w-4 text-yellow-500" />;
}

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

function JobsTable({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) {
    return (
      <p className="px-4 py-8 text-sm text-muted-foreground text-center">
        No jobs found.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="px-4 py-3 font-medium text-muted-foreground">Type</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Video</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">User</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Error</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Started</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job._id} className="border-b last:border-0 hover:bg-muted/30">
              <td className="px-4 py-3">
                <Badge
                  className={cn(
                    "text-xs",
                    job.type === "publish"
                      ? "bg-blue-500 text-white hover:bg-blue-600"
                      : "bg-purple-500 text-white hover:bg-purple-600"
                  )}
                >
                  {job.type}
                </Badge>
              </td>
              <td className="px-4 py-3 truncate max-w-[160px]">
                {job.videoTitle ?? "—"}
              </td>
              <td className="px-4 py-3 text-muted-foreground truncate max-w-[160px]">
                {job.userEmail ?? "—"}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-1.5">
                  <StatusIcon status={job.status} />
                  <span className="capitalize text-xs">{job.status}</span>
                </div>
              </td>
              <td className="px-4 py-3 max-w-[200px]">
                {job.error ? (
                  <span className="text-red-500 text-xs">
                    {job.error.slice(0, 50)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground whitespace-nowrap text-xs">
                {job.startedAt ? formatDateTimeEAT(job.startedAt) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminJobsPage() {
  const [tab, setTab] = useState<Tab>("recent");
  const recentJobs = useQuery(api.admin.jobs.listRecent, { limit: 50 });
  const failedJobs = useQuery(api.admin.jobs.listFailed, { limit: 50 });

  const jobs = tab === "recent" ? recentJobs : failedJobs;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Jobs</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Monitor publish and generation jobs across all users.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-2 border-b">
        {(["recent", "failed"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "recent" ? "Recent" : "Failed"}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {jobs === undefined ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : (
            <JobsTable jobs={jobs as Job[]} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
