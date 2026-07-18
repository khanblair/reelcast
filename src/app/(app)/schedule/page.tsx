"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import {
  CalendarClock, CalendarCheck, Clock, X, ExternalLink, ChevronDown, ChevronUp,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { format, formatDistanceToNow, isFuture, isPast } from "date-fns";

type ScheduleFilter = "all" | "upcoming" | "past";

const FILTER_TABS: { key: ScheduleFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
];

const PRIVACY_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
] as const;

function toLocalDatetimeValue(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function minDatetimeValue() {
  return toLocalDatetimeValue(Date.now() + 60_000);
}

export default function SchedulePage() {
  const scheduledVideos = useQuery(api.videos.listScheduled);
  const allVideos = useQuery(api.videos.list);
  const schedulePublish = useMutation(api.videos.schedulePublish);
  const cancelSchedule = useMutation(api.videos.cancelSchedule);

  const [filter, setFilter] = useState<ScheduleFilter>("upcoming");
  const [showForm, setShowForm] = useState(false);
  const [selectedVideoId, setSelectedVideoId] = useState<string>("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [privacy, setPrivacy] = useState<"private" | "public" | "unlisted">("private");
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const loading = scheduledVideos === undefined || allVideos === undefined;

  if (loading) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  const schedulableVideos = allVideos.filter((v) => v.status === "ready");

  const filtered = scheduledVideos.filter((v) => {
    const t = v.scheduledPublishAt!;
    if (filter === "upcoming") return isFuture(t) && v.status === "scheduled";
    if (filter === "past") return isPast(t) || v.status === "published";
    return true;
  });

  const handleSchedule = async () => {
    if (!selectedVideoId || !scheduledAt) return;
    setSubmitting(true);
    try {
      await schedulePublish({
        id: selectedVideoId as Id<"videos">,
        scheduledAt: new Date(scheduledAt).getTime(),
        privacyStatus: privacy,
      });
      setShowForm(false);
      setSelectedVideoId("");
      setScheduledAt("");
      setPrivacy("private");
      setFilter("upcoming");
    } catch (e) {
      console.error("Failed to schedule:", e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: Id<"videos">) => {
    setCancellingId(id);
    try {
      await cancelSchedule({ id });
    } catch (e) {
      console.error("Failed to cancel:", e);
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Scheduled Publishes</h1>
          <p className="text-muted-foreground">Set a date and time — your video publishes to YouTube automatically.</p>
        </div>
        <Button onClick={() => setShowForm((p) => !p)} disabled={schedulableVideos.length === 0}>
          {showForm ? <ChevronUp className="mr-2 h-4 w-4" /> : <ChevronDown className="mr-2 h-4 w-4" />}
          Schedule a Video
        </Button>
      </div>

      {/* Schedule form */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New Scheduled Publish</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Video</label>
                <select
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={selectedVideoId}
                  onChange={(e) => setSelectedVideoId(e.target.value)}
                >
                  <option value="">Select a video…</option>
                  {schedulableVideos.map((v) => (
                    <option key={v._id} value={v._id}>{v.title}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Publish at</label>
                <input
                  type="datetime-local"
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  min={minDatetimeValue()}
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Privacy</label>
              <div className="flex gap-2">
                {PRIVACY_OPTIONS.map((opt) => (
                  <Button
                    key={opt.value}
                    size="sm"
                    variant={privacy === opt.value ? "default" : "outline"}
                    onClick={() => setPrivacy(opt.value)}
                    type="button"
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <Button
                onClick={handleSchedule}
                disabled={!selectedVideoId || !scheduledAt || submitting}
              >
                {submitting ? <LoadingSpinner size="sm" /> : <CalendarClock className="mr-2 h-4 w-4" />}
                {submitting ? "Scheduling…" : "Confirm Schedule"}
              </Button>
              <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_TABS.map((tab) => (
          <Button
            key={tab.key}
            size="sm"
            variant={filter === tab.key ? "default" : "outline"}
            onClick={() => setFilter(tab.key)}
          >
            {tab.label}
            {tab.key !== "all" && (
              <span className="ml-1.5 text-xs opacity-70">
                {tab.key === "upcoming"
                  ? scheduledVideos.filter((v) => isFuture(v.scheduledPublishAt!) && v.status === "scheduled").length
                  : scheduledVideos.filter((v) => isPast(v.scheduledPublishAt!) || v.status === "published").length}
              </span>
            )}
          </Button>
        ))}
      </div>

      {/* List */}
      {filtered.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {filtered.map((video) => {
                const ts = video.scheduledPublishAt!;
                const upcoming = isFuture(ts) && video.status === "scheduled";
                const isCancelling = cancellingId === video._id;

                return (
                  <div key={video._id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      {upcoming
                        ? <Clock className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
                        : <CalendarCheck className="h-4 w-4 mt-0.5 shrink-0 text-success" />
                      }
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-sm truncate">{video.title}</span>
                          <Badge
                            variant="outline"
                            className={`capitalize text-xs border ${
                              upcoming
                                ? "bg-primary/10 text-primary border-primary/30"
                                : video.status === "published"
                                ? "bg-success/10 text-success border-success/30"
                                : "bg-destructive/10 text-destructive border-destructive/30"
                            }`}
                          >
                            {video.status}
                          </Badge>
                          {video.privacyStatus && (
                            <Badge variant="outline" className="text-xs capitalize">
                              {video.privacyStatus}
                            </Badge>
                          )}
                          {(video as any).cloudinaryDeletedAt && (
                            <Badge variant="outline" className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30">
                              Storage freed
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground space-y-0.5">
                          <div>
                            {upcoming ? "Publishes" : "Published"}{" "}
                            <span className="font-medium text-foreground">
                              {format(ts, "MMM d, yyyy 'at' h:mm a")}
                            </span>
                          </div>
                          <div>
                            {upcoming
                              ? `in ${formatDistanceToNow(ts)}`
                              : formatDistanceToNow(ts, { addSuffix: true })}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <Link href={`/video/${video._id}`}>
                        <Button variant="ghost" size="sm">
                          <ExternalLink className="h-3.5 w-3.5 mr-1" />
                          View
                        </Button>
                      </Link>
                      {upcoming && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isCancelling}
                          onClick={() => handleCancel(video._id as Id<"videos">)}
                        >
                          <X className={`h-3.5 w-3.5 mr-1 ${isCancelling ? "animate-spin" : ""}`} />
                          {isCancelling ? "Cancelling…" : "Cancel"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={CalendarClock}
          title={
            filter === "upcoming"
              ? "No upcoming scheduled publishes"
              : filter === "past"
              ? "No past scheduled publishes"
              : "No scheduled publishes yet"
          }
          description={
            filter === "upcoming"
              ? "Use the button above to schedule a ready video for automatic publishing."
              : "Videos you've scheduled in the past will appear here."
          }
        />
      )}
    </div>
  );
}
