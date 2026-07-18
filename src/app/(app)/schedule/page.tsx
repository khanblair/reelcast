"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import {
  CalendarClock, CalendarCheck, Clock, X, ExternalLink,
  ChevronDown, ChevronUp, ArrowUp, ArrowDown, ListVideo, Zap,
  Calendar, CheckSquare, Square,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { format, formatDistanceToNow, isFuture, isPast } from "date-fns";

type PageMode = "auto" | "single";
type ScheduleFilter = "all" | "upcoming" | "past";

const PRIVACY_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
] as const;

const FILTER_TABS: { key: ScheduleFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
];

const INTERVALS = [
  { value: 60, label: "1 hr" },
  { value: 120, label: "2 hrs" },
  { value: 240, label: "4 hrs" },
  { value: 360, label: "6 hrs" },
  { value: 480, label: "8 hrs" },
  { value: 720, label: "12 hrs" },
  { value: 1440, label: "Daily" },
];

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

  const [mode, setMode] = useState<PageMode>("auto");
  const [filter, setFilter] = useState<ScheduleFilter>("upcoming");
  const [showForm, setShowForm] = useState(true);

  // Single-video state
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [privacy, setPrivacy] = useState<"private" | "public" | "unlisted">("private");
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Auto-schedule state
  const [queue, setQueue] = useState<string[]>([]);
  const [autoStartTime, setAutoStartTime] = useState("");
  const [intervalMin, setIntervalMin] = useState(1440);
  const [autoPrivacy, setAutoPrivacy] = useState<"private" | "public" | "unlisted">("private");
  const [autoSubmitting, setAutoSubmitting] = useState(false);
  const [autoProgress, setAutoProgress] = useState<{ done: number; total: number } | null>(null);

  const loading = scheduledVideos === undefined || allVideos === undefined;

  const schedulableVideos = useMemo(
    () => allVideos?.filter((v) => v.status === "ready") ?? [],
    [allVideos]
  );

  const videoMap = useMemo(
    () => new Map(allVideos?.map((v) => [v._id as string, v]) ?? []),
    [allVideos]
  );

  const filtered = useMemo(() => {
    if (!scheduledVideos) return [];
    return scheduledVideos.filter((v) => {
      const t = v.scheduledPublishAt!;
      if (filter === "upcoming") return isFuture(t) && v.status === "scheduled";
      if (filter === "past") return isPast(t) || v.status === "published";
      return true;
    });
  }, [scheduledVideos, filter]);

  const previewTimes = useMemo(() => {
    if (!autoStartTime || queue.length === 0) return [];
    const startMs = new Date(autoStartTime).getTime();
    return queue.map((id, i) => ({
      id,
      time: startMs + i * intervalMin * 60_000,
    }));
  }, [queue, autoStartTime, intervalMin]);

  const handleScheduleSingle = async () => {
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
      setFilter("upcoming");
    } catch (e) {
      console.error("Failed to schedule:", e);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleVideo = useCallback((id: string) => {
    setQueue((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const moveInQueue = useCallback((index: number, dir: -1 | 1) => {
    setQueue((prev) => {
      const next = index + dir;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      [arr[index], arr[next]] = [arr[next], arr[index]];
      return arr;
    });
  }, []);

  const removeFromQueue = useCallback((id: string) => {
    setQueue((prev) => prev.filter((x) => x !== id));
  }, []);

  const handleAutoSchedule = async () => {
    if (queue.length === 0 || !autoStartTime) return;
    setAutoSubmitting(true);
    setAutoProgress({ done: 0, total: queue.length });
    try {
      const startMs = new Date(autoStartTime).getTime();
      for (let i = 0; i < queue.length; i++) {
        await schedulePublish({
          id: queue[i] as Id<"videos">,
          scheduledAt: startMs + i * intervalMin * 60_000,
          privacyStatus: autoPrivacy,
        });
        setAutoProgress({ done: i + 1, total: queue.length });
      }
      setQueue([]);
      setAutoStartTime("");
      setShowForm(false);
      setFilter("upcoming");
    } catch (e) {
      console.error("Auto-schedule failed:", e);
    } finally {
      setAutoSubmitting(false);
      setAutoProgress(null);
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

  if (loading) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
            Scheduled Publishes
          </h1>
          <p className="text-muted-foreground">
            Queue videos for automatic publishing to YouTube.
          </p>
        </div>
        <Button
          variant={showForm ? "outline" : "default"}
          onClick={() => setShowForm((p) => !p)}
          disabled={schedulableVideos.length === 0}
        >
          {showForm
            ? <ChevronUp className="mr-2 h-4 w-4" />
            : <ChevronDown className="mr-2 h-4 w-4" />}
          Schedule Videos
        </Button>
      </div>

      {/* Schedule panel */}
      {showForm && (
        <Card>
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit">
              <button
                type="button"
                onClick={() => setMode("auto")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === "auto"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Zap className="h-3.5 w-3.5" />
                Auto-Schedule
              </button>
              <button
                type="button"
                onClick={() => setMode("single")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === "single"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Calendar className="h-3.5 w-3.5" />
                Single Video
              </button>
            </div>
          </CardHeader>

          <CardContent className="pt-3">
            {mode === "single" ? (
              /* ── Single-video form ── */
              <div className="space-y-4">
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
                        <option key={v._id} value={v._id}>
                          {(v as any).aiTitle ?? v.title}
                        </option>
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
                    onClick={handleScheduleSingle}
                    disabled={!selectedVideoId || !scheduledAt || submitting}
                  >
                    {submitting
                      ? <LoadingSpinner size="sm" />
                      : <CalendarClock className="mr-2 h-4 w-4" />}
                    {submitting ? "Scheduling…" : "Confirm Schedule"}
                  </Button>
                  <Button variant="outline" onClick={() => setShowForm(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              /* ── Auto-schedule form ── */
              <div className="space-y-5">
                <div className="grid md:grid-cols-2 gap-4">
                  {/* Video checklist */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">Available Videos</label>
                      <div className="flex gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() => setQueue(schedulableVideos.map((v) => v._id))}
                          className="text-primary hover:underline"
                        >
                          Select all
                        </button>
                        {queue.length > 0 && (
                          <>
                            <span className="text-muted-foreground">·</span>
                            <button
                              type="button"
                              onClick={() => setQueue([])}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              Clear
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {schedulableVideos.length === 0 ? (
                      <div className="border rounded-md flex items-center justify-center h-32 text-sm text-muted-foreground">
                        No ready videos available
                      </div>
                    ) : (
                      <div className="border rounded-md divide-y max-h-52 overflow-y-auto">
                        {schedulableVideos.map((v) => {
                          const checked = queue.includes(v._id);
                          const pos = queue.indexOf(v._id);
                          return (
                            <button
                              key={v._id}
                              type="button"
                              onClick={() => toggleVideo(v._id)}
                              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors ${
                                checked ? "bg-primary/5" : ""
                              }`}
                            >
                              {checked
                                ? <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                                : <Square className="h-4 w-4 text-muted-foreground shrink-0" />
                              }
                              <span className="text-sm truncate flex-1">
                                {(v as any).aiTitle ?? v.title}
                              </span>
                              {checked && (
                                <span className="ml-auto text-xs text-primary font-medium">
                                  #{pos + 1}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Queue with reorder */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Queue
                      {queue.length > 0 && (
                        <span className="ml-1.5 text-muted-foreground font-normal text-xs">
                          ({queue.length} video{queue.length !== 1 ? "s" : ""})
                        </span>
                      )}
                    </label>
                    {queue.length === 0 ? (
                      <div className="border rounded-md border-dashed flex items-center justify-center h-32">
                        <div className="text-center text-sm text-muted-foreground">
                          <ListVideo className="h-5 w-5 mx-auto mb-1 opacity-40" />
                          Select videos to queue them
                        </div>
                      </div>
                    ) : (
                      <div className="border rounded-md divide-y max-h-52 overflow-y-auto">
                        {queue.map((id, i) => {
                          const v = videoMap.get(id);
                          if (!v) return null;
                          return (
                            <div key={id} className="flex items-center gap-2 px-3 py-2">
                              <span className="text-xs text-muted-foreground w-5 shrink-0 font-mono tabular-nums">
                                {i + 1}
                              </span>
                              <span className="text-sm truncate flex-1">
                                {(v as any).aiTitle ?? v.title}
                              </span>
                              <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                  type="button"
                                  onClick={() => moveInQueue(i, -1)}
                                  disabled={i === 0}
                                  className="p-1 rounded hover:bg-muted disabled:opacity-30"
                                >
                                  <ArrowUp className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => moveInQueue(i, 1)}
                                  disabled={i === queue.length - 1}
                                  className="p-1 rounded hover:bg-muted disabled:opacity-30"
                                >
                                  <ArrowDown className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeFromQueue(id)}
                                  className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>

                {/* Settings */}
                <div className="space-y-4 pt-1 border-t">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">First publish at</label>
                      <input
                        type="datetime-local"
                        className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        min={minDatetimeValue()}
                        value={autoStartTime}
                        onChange={(e) => setAutoStartTime(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Interval between videos</label>
                      <div className="flex flex-wrap gap-1.5">
                        {INTERVALS.map((int) => (
                          <button
                            key={int.value}
                            type="button"
                            onClick={() => setIntervalMin(int.value)}
                            className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                              intervalMin === int.value
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-background border-input hover:border-primary/50 hover:bg-muted"
                            }`}
                          >
                            {int.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Privacy</label>
                    <div className="flex gap-2">
                      {PRIVACY_OPTIONS.map((opt) => (
                        <Button
                          key={opt.value}
                          size="sm"
                          variant={autoPrivacy === opt.value ? "default" : "outline"}
                          onClick={() => setAutoPrivacy(opt.value)}
                          type="button"
                        >
                          {opt.label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {/* Live preview */}
                  {previewTimes.length > 0 && (
                    <div className="bg-muted/50 rounded-lg p-3">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                        Schedule Preview
                      </p>
                      <div className="space-y-1.5 max-h-36 overflow-y-auto">
                        {previewTimes.map(({ id, time }, i) => {
                          const v = videoMap.get(id);
                          return (
                            <div
                              key={id}
                              className="flex items-center justify-between gap-3 text-xs"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-muted-foreground font-mono w-4 shrink-0 tabular-nums">
                                  {i + 1}.
                                </span>
                                <span className="truncate">
                                  {(v as any)?.aiTitle ?? v?.title}
                                </span>
                              </div>
                              <span className="text-muted-foreground shrink-0">
                                {format(time, "MMM d, h:mm a")}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={handleAutoSchedule}
                    disabled={queue.length === 0 || !autoStartTime || autoSubmitting}
                  >
                    {autoSubmitting ? (
                      <>
                        <LoadingSpinner size="sm" />
                        <span className="ml-2">
                          {autoProgress
                            ? `Scheduling ${autoProgress.done}/${autoProgress.total}…`
                            : "Scheduling…"}
                        </span>
                      </>
                    ) : (
                      <>
                        <Zap className="mr-2 h-4 w-4" />
                        {queue.length > 0
                          ? `Auto-Schedule ${queue.length} Video${queue.length !== 1 ? "s" : ""}`
                          : "Auto-Schedule"}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowForm(false);
                      setQueue([]);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_TABS.map((tab) => (
          <Button
            key={tab.key}
            size="sm"
            variant={filter === tab.key ? "default" : "outline"}
            onClick={() => setFilter(tab.key)}
          >
            {tab.label}
            {tab.key !== "all" && scheduledVideos && (
              <span className="ml-1.5 text-xs opacity-70">
                {tab.key === "upcoming"
                  ? scheduledVideos.filter(
                      (v) => isFuture(v.scheduledPublishAt!) && v.status === "scheduled"
                    ).length
                  : scheduledVideos.filter(
                      (v) => isPast(v.scheduledPublishAt!) || v.status === "published"
                    ).length}
              </span>
            )}
          </Button>
        ))}
      </div>

      {/* Scheduled list */}
      {filtered.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {filtered.map((video) => {
                const ts = video.scheduledPublishAt!;
                const upcoming = isFuture(ts) && video.status === "scheduled";
                const isCancelling = cancellingId === video._id;

                return (
                  <div
                    key={video._id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      {upcoming
                        ? <Clock className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
                        : <CalendarCheck className="h-4 w-4 mt-0.5 shrink-0 text-success" />
                      }
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-sm truncate">
                            {(video as any).aiTitle ?? video.title}
                          </span>
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
                            <Badge
                              variant="outline"
                              className="text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                            >
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
                          <X
                            className={`h-3.5 w-3.5 mr-1 ${isCancelling ? "animate-spin" : ""}`}
                          />
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
              ? "Use the button above to schedule ready videos for automatic publishing."
              : "Videos you've scheduled in the past will appear here."
          }
        />
      )}
    </div>
  );
}
