"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { History, RefreshCw, ExternalLink, CheckCircle, Clock, XCircle, Loader2, Wand2, CalendarClock } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDistanceToNow } from "date-fns";
import { formatDateTimeEAT, formatFullDateEAT } from "@/lib/eat";

type JobFilter = "all" | "generation" | "publish" | "metadata" | "scheduled";

const FILTER_TABS: { key: JobFilter; label: string }[] = [
  { key: "all",       label: "All Jobs" },
  { key: "generation", label: "AI Generation" },
  { key: "publish",   label: "YouTube Publish" },
  { key: "metadata",  label: "Metadata Queue" },
  { key: "scheduled", label: "Scheduled Publish" },
];

const STATUS_STYLES: Record<string, string> = {
  pending:    "bg-warning/20 text-warning border-warning/30",
  processing: "bg-primary/20 text-primary border-primary/30",
  completed:  "bg-success/20 text-success border-success/30",
  failed:     "bg-destructive/20 text-destructive border-destructive/30",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending:    <Clock className="h-4 w-4 text-warning" />,
  processing: <Loader2 className="h-4 w-4 animate-spin text-primary" />,
  completed:  <CheckCircle className="h-4 w-4 text-success" />,
  failed:     <XCircle className="h-4 w-4 text-destructive" />,
};

export default function HistoryPage() {
  const jobs            = useQuery(api.jobs.list);
  const videos          = useQuery(api.videos.list);
  const scheduledVideos = useQuery(api.videos.listScheduled);
  const retryJob        = useMutation(api.jobs.retryJob);
  const [filter, setFilter]       = useState<JobFilter>("all");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const loading = jobs === undefined || videos === undefined || scheduledVideos === undefined;

  const videoMap = useMemo(
    () => new Map((videos ?? []).map((v) => [v._id, v])),
    [videos]
  );

  // Metadata queue — draft videos with a future metadataScheduledAt
  const metadataQueue = useMemo(
    () => (videos ?? [])
      .filter(v => v.status === "draft" && v.metadataScheduledAt && v.metadataScheduledAt > Date.now())
      .sort((a, b) => (a.metadataScheduledAt ?? 0) - (b.metadataScheduledAt ?? 0)),
    [videos]
  );

  // Scheduled publish — videos waiting for their pinned publish time
  const scheduledQueue = useMemo(
    () => (scheduledVideos ?? [])
      .filter(v => v.status === "scheduled" && v.scheduledPublishAt)
      .sort((a, b) => (a.scheduledPublishAt ?? 0) - (b.scheduledPublishAt ?? 0)),
    [scheduledVideos]
  );

  const filteredJobs = useMemo(() => {
    if (!jobs) return [];
    if (filter === "all")        return jobs;
    if (filter === "generation") return jobs.filter(j => j.type === "generation");
    if (filter === "publish")    return jobs.filter(j => j.type === "publish");
    return [];
  }, [jobs, filter]);

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

  if (loading) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  const isMetadataTab  = filter === "metadata";
  const isScheduledTab = filter === "scheduled";
  const isJobsTab      = !isMetadataTab && !isScheduledTab;

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Job History</h1>
        <p className="text-muted-foreground">View the history of all your AI generation, publishing, and scheduling tasks.</p>
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
            {tab.key === "metadata"  && metadataQueue.length > 0  && (
              <span className="ml-1.5 text-xs opacity-70">{metadataQueue.length}</span>
            )}
            {tab.key === "scheduled" && scheduledQueue.length > 0 && (
              <span className="ml-1.5 text-xs opacity-70">{scheduledQueue.length}</span>
            )}
          </Button>
        ))}
      </div>

      {/* ── Metadata Queue tab ── */}
      {isMetadataTab && (
        metadataQueue.length > 0 ? (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {metadataQueue.map((video) => (
                  <div key={video._id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <Wand2 className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-sm truncate">
                            {video.aiTitle ?? video.title}
                          </span>
                          <Badge variant="outline" className="text-xs border bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30">
                            Queued
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          <div>
                            AI metadata scheduled for{" "}
                            <span className="font-medium text-foreground">
                              {formatFullDateEAT(video.metadataScheduledAt!)}
                            </span>
                          </div>
                          <div>{formatDistanceToNow(video.metadataScheduledAt!, { addSuffix: true })}</div>
                        </div>
                      </div>
                    </div>
                    <Link href={`/video/${video._id}`}>
                      <Button variant="ghost" size="sm" className="shrink-0">
                        <ExternalLink className="h-3.5 w-3.5 mr-1" /> View
                      </Button>
                    </Link>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            icon={Wand2}
            title="No metadata jobs queued"
            description="Go to Schedule → Metadata to queue AI metadata generation for your draft videos."
          />
        )
      )}

      {/* ── Scheduled Publish tab ── */}
      {isScheduledTab && (
        scheduledQueue.length > 0 ? (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {scheduledQueue.map((video) => (
                  <div key={video._id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <CalendarClock className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-sm truncate">
                            {video.aiTitle ?? video.title}
                          </span>
                          <Badge variant="outline" className="text-xs border bg-primary/10 text-primary border-primary/30">
                            Scheduled
                          </Badge>
                          {video.privacyStatus && (
                            <Badge variant="outline" className="text-xs capitalize">
                              {video.privacyStatus}
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          <div>
                            Publishes{" "}
                            <span className="font-medium text-foreground">
                              {formatFullDateEAT(video.scheduledPublishAt!)}
                            </span>
                          </div>
                          <div>{formatDistanceToNow(video.scheduledPublishAt!, { addSuffix: true })}</div>
                        </div>
                      </div>
                    </div>
                    <Link href={`/video/${video._id}`}>
                      <Button variant="ghost" size="sm" className="shrink-0">
                        <ExternalLink className="h-3.5 w-3.5 mr-1" /> View
                      </Button>
                    </Link>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="No scheduled publishes"
            description="Go to Schedule → Single Video to pin a publish time for a ready video."
          />
        )
      )}

      {/* ── Jobs tabs (all / generation / publish) ── */}
      {isJobsTab && (
        filteredJobs.length > 0 ? (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {filteredJobs.map((job) => {
                  const video    = videoMap.get(job.videoId);
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
                              <span>
                                Started{" "}
                                <span className="font-medium text-foreground">
                                  {formatDateTimeEAT(job.startedAt)}
                                </span>
                                {" "}({formatDistanceToNow(job.startedAt, { addSuffix: true })})
                              </span>
                            ) : (
                              <span>
                                Created{" "}
                                <span className="font-medium text-foreground">
                                  {formatDateTimeEAT(job._creationTime)}
                                </span>
                              </span>
                            )}
                            {job.completedAt && (
                              <div>
                                Completed{" "}
                                <span className="font-medium text-foreground">
                                  {formatDateTimeEAT(job.completedAt)}
                                </span>
                              </div>
                            )}
                            {video && (
                              <div className="flex items-center gap-1 pt-0.5">
                                <span>Video:</span>
                                <Link
                                  href={`/video/${(video as any)._id}`}
                                  className="text-primary hover:underline inline-flex items-center gap-1"
                                >
                                  {(video as any).title}
                                  <ExternalLink className="h-3 w-3" />
                                </Link>
                              </div>
                            )}
                            {job.error && (
                              <div className="text-destructive text-xs pt-0.5 break-words">
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
        )
      )}
    </div>
  );
}
