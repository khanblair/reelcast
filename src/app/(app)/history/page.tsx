"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { History, RefreshCw, ExternalLink, CheckCircle, Clock, XCircle, Loader2 } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDistanceToNow } from "date-fns";

type JobFilter = "all" | "generation" | "publish";

const FILTER_TABS: { key: JobFilter; label: string }[] = [
  { key: "all", label: "All Jobs" },
  { key: "generation", label: "AI Generation" },
  { key: "publish", label: "YouTube Publish" },
];

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-warning/20 text-warning border-warning/30",
  processing: "bg-primary/20 text-primary border-primary/30",
  completed: "bg-success/20 text-success border-success/30",
  failed: "bg-destructive/20 text-destructive border-destructive/30",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="h-4 w-4 text-warning" />,
  processing: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
  completed: <CheckCircle className="h-4 w-4 text-success" />,
  failed: <XCircle className="h-4 w-4 text-destructive" />,
};

export default function HistoryPage() {
  const jobs = useQuery(api.jobs.list);
  const videos = useQuery(api.videos.list);
  const retryJob = useMutation(api.jobs.retryJob);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loading = jobs === undefined || videos === undefined;

  if (loading) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  const videoMap = new Map(videos.map((v) => [v._id, v]));

  const filteredJobs = filter === "all"
    ? jobs
    : jobs.filter((j) => j.type === filter);

  const handleRetry = async (jobId: Id<"jobs">) => {
    setRetryingId(jobId);
    try {
      await retryJob({ id: jobId });
    } catch (e) {
      console.error("Retry failed:", e);
    } finally {
      setRetryingId(null);
    }
  };

  const getStatusBadge = (status: string) => (
    <Badge variant="outline" className={`capitalize text-xs border ${STATUS_STYLES[status] || ""}`}>
      {status === "processing" ? "Processing" : status}
    </Badge>
  );

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Job History</h1>
        <p className="text-muted-foreground">View the history of all your AI generation and publishing tasks.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTER_TABS.map((tab) => (
          <Button
            key={tab.key}
            variant={filter === tab.key ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {filteredJobs.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {filteredJobs.map((job) => {
                const video = videoMap.get(job.videoId);
                const isRetrying = retryingId === job._id;

                return (
                  <div key={job._id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      {STATUS_ICONS[job.status] || <Clock className="h-4 w-4" />}
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-sm">
                            {job.type === "generation" ? "AI Generation" : "YouTube Publish"}
                          </span>
                          {getStatusBadge(job.status)}
                        </div>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          {job.startedAt ? (
                            <span>Started {formatDistanceToNow(job.startedAt, { addSuffix: true })}</span>
                          ) : (
                            <span>Created {formatDistanceToNow(job._creationTime, { addSuffix: true })}</span>
                          )}
                          {job.completedAt && (
                            <span className="ml-2">
                              &middot; Completed {formatDistanceToNow(job.completedAt, { addSuffix: true })}
                            </span>
                          )}
                          {video && (
                            <div className="flex items-center gap-1 pt-0.5">
                              <span>Video:</span>
                              <Link
                                href={`/video/${video._id}`}
                                className="text-primary hover:underline inline-flex items-center gap-1"
                              >
                                {video.title}
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            </div>
                          )}
                          {job.error && (
                            <div className="text-destructive text-xs pt-0.5">
                              Error: {job.error}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {job.status === "failed" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={isRetrying}
                        onClick={() => handleRetry(job._id)}
                      >
                        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isRetrying ? "animate-spin" : ""}`} />
                        {isRetrying ? "Retrying..." : "Retry"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={History}
          title="No job history"
          description={
            filter === "all"
              ? "Your AI generation and publishing tasks will appear here."
              : `No ${FILTER_TABS.find((t) => t.key === filter)?.label.toLowerCase()} jobs found.`
          }
        />
      )}
    </div>
  );
}
