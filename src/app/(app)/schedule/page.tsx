"use client";

import { useState, useMemo, useCallback } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQuery, useMutation, useAction } from "convex/react";
import {
  CalendarClock, CalendarCheck, Clock, X, ExternalLink,
  ChevronDown, ChevronUp, Zap,
  Calendar, CheckSquare, Square, Wand2, RefreshCw, CheckCircle, XCircle,
  CalendarDays, Sparkles,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { format, formatDistanceToNow, isFuture, isPast } from "date-fns";
import { WeekStrip } from "@/components/calendar/week-strip";

type PageMode = "auto" | "single" | "metadata";
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

// Research-backed optimal YouTube Shorts posting times (EAT / UTC+3)
const OPTIMAL_SLOTS = [
  { hour: 7,  label: "7 AM",  reason: "Morning commute" },
  { hour: 12, label: "12 PM", reason: "Lunch peak" },
  { hour: 17, label: "5 PM",  reason: "After work" },
  { hour: 20, label: "8 PM",  reason: "Prime time" },
];

// All 24 hours for custom selection
const ALL_HOURS = Array.from({ length: 24 }, (_, h) => ({
  hour: h,
  label: h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`,
}));

const TIMEZONE_OPTIONS = [
  { value: -8,   label: "PST (UTC−8)",    desc: "US Pacific" },
  { value: -5,   label: "EST (UTC−5)",    desc: "US Eastern" },
  { value: 0,    label: "UTC",            desc: "Global / UK" },
  { value: 1,    label: "WAT (UTC+1)",    desc: "West Africa / Nigeria" },
  { value: 3,    label: "EAT (UTC+3)",    desc: "East Africa / Nairobi" },
  { value: 5.5,  label: "IST (UTC+5:30)", desc: "India" },
  { value: 8,    label: "SGT (UTC+8)",    desc: "China / Singapore" },
];

function nextEATSlot(slots: number[], tzOffsetHours = 3): number {
  const TZ_OFFSET_MS = tzOffsetHours * 60 * 60 * 1000;
  const now = Date.now();
  const eatMs = now + TZ_OFFSET_MS;
  const eatDate = new Date(eatMs);
  const msSinceEatMidnight =
    eatDate.getUTCHours() * 3_600_000 +
    eatDate.getUTCMinutes() * 60_000 +
    eatDate.getUTCSeconds() * 1_000 +
    eatDate.getUTCMilliseconds();
  const eatMidnightMs = now - msSinceEatMidnight;

  const sorted = [...slots].sort((a, b) => a - b);
  const minFuture = now + 60_000;
  for (const h of sorted) {
    const slotMs = eatMidnightMs + h * 3_600_000;
    if (slotMs >= minFuture) return slotMs;
  }
  return eatMidnightMs + 24 * 3_600_000 + sorted[0] * 3_600_000;
}

const META_INTERVALS = [
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
  const userSettings = useQuery(api.settings.get);
  const suggestedTimes = useQuery(api.scheduling.getSuggestedTimes);
  const schedulePublish    = useMutation(api.videos.schedulePublish);
  const cancelSchedule     = useMutation(api.videos.cancelSchedule);
  const scheduleMetadata   = useMutation(api.videos.scheduleMetadataForVideo);
  const startAutoPublish   = useMutation(api.settings.startAutoPublish);
  const stopAutoPublish    = useMutation(api.settings.stopAutoPublish);
  const regenMetadata      = useAction(api.actions.metadata.generateForUpload);

  const [mode, setMode] = useState<PageMode>("auto");
  const [filter, setFilter] = useState<ScheduleFilter>("upcoming");
  const [showForm, setShowForm] = useState(true);

  // Single-video state
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [privacy, setPrivacy] = useState<"private" | "public" | "unlisted">("public");
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  // Auto-schedule state
  const [autoStartTime, setAutoStartTime] = useState("");
  const [intervalMin, setIntervalMin] = useState(360);
  const [autoCount, setAutoCount] = useState(1);
  const [autoPrivacy, setAutoPrivacy] = useState<"private" | "public" | "unlisted">("public");
  const [autoSubmitting, setAutoSubmitting] = useState(false);
  const [timeSlots, setTimeSlots] = useState<number[]>([7, 12, 17, 20]);
  const [showAllHours, setShowAllHours] = useState(false);
  const [tzOffset, setTzOffset] = useState(3); // default EAT

  // Metadata-schedule state
  const [metaMode, setMetaMode] = useState<"schedule" | "now">("schedule");
  const [metaQueue, setMetaQueue] = useState<string[]>([]);
  const [metaStartTime, setMetaStartTime] = useState("");
  const [metaIntervalMin, setMetaIntervalMin] = useState(60);
  const [metaSubmitting, setMetaSubmitting] = useState(false);
  const [metaProgress, setMetaProgress] = useState<{ done: number; total: number } | null>(null);
  // Regenerate-now state
  const [regenQueue, setRegenQueue] = useState<string[]>([]);
  const [regenProgress, setRegenProgress] = useState<{ done: number; total: number; results: { id: string; success: boolean }[] } | null>(null);
  const [regenSubmitting, setRegenSubmitting] = useState(false);

  const loading = scheduledVideos === undefined || allVideos === undefined;

  const schedulableVideos = useMemo(
    () => allVideos?.filter((v) => v.status === "ready") ?? [],
    [allVideos]
  );

  // Drafts without a pending metadata job, safe to schedule
  const draftVideos = useMemo(
    () => {
      const now = Date.now();
      return allVideos?.filter((v) => {
        if (v.status !== "draft") return false;
        const scheduledAt = v.metadataScheduledAt;
        return !scheduledAt || scheduledAt <= now;
      }) ?? [];
    },
    [allVideos]
  );

  // Drafts that already have a future metadata job queued
  const pendingMetadataVideos = useMemo(
    () => {
      const now = Date.now();
      return allVideos?.filter((v) => {
        if (v.status !== "draft") return false;
        const scheduledAt = v.metadataScheduledAt;
        return scheduledAt !== undefined && scheduledAt > now;
      }) ?? [];
    },
    [allVideos]
  );

  // All videos eligible for immediate metadata regeneration (draft + ready)
  const regenEligibleVideos = useMemo(
    () => allVideos?.filter((v) => v.status === "draft" || v.status === "ready") ?? [],
    [allVideos]
  );

  const videoMap = useMemo(
    () => new Map(allVideos?.map((v) => [v._id as string, v]) ?? []),
    [allVideos]
  );

  const scheduledTimestamps = useMemo(() => {
    if (!scheduledVideos) return [];
    return scheduledVideos
      .filter((v) => v.scheduledPublishAt && v.status === "scheduled")
      .map((v) => v.scheduledPublishAt as number);
  }, [scheduledVideos]);

  const filtered = useMemo(() => {
    if (!scheduledVideos) return [];
    return scheduledVideos.filter((v) => {
      const t = v.scheduledPublishAt!;
      if (filter === "upcoming") return isFuture(t) && v.status === "scheduled";
      if (filter === "past") return isPast(t) || v.status === "published";
      return true;
    });
  }, [scheduledVideos, filter]);

  const isAutoActive = userSettings?.autoPublishEnabled === true;

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

  const handleStartAutoPublish = async () => {
    if (timeSlots.length === 0) return;
    setAutoSubmitting(true);
    try {
      const scheduledAt = autoStartTime
        ? new Date(autoStartTime).getTime()
        : nextEATSlot(timeSlots, tzOffset);
      await startAutoPublish({
        scheduledAt,
        intervalMs: intervalMin * 60_000,
        count: autoCount,
        privacy: autoPrivacy,
        timeSlots,
        timezoneOffset: tzOffset,
      });
      setAutoStartTime("");
    } catch (e) {
      console.error("Failed to start auto-publish:", e);
    } finally {
      setAutoSubmitting(false);
    }
  };

  const handleStopAutoPublish = async () => {
    setAutoSubmitting(true);
    try {
      await stopAutoPublish();
    } catch (e) {
      console.error("Failed to stop auto-publish:", e);
    } finally {
      setAutoSubmitting(false);
    }
  };

  const toggleMetaVideo = useCallback((id: string) => {
    setMetaQueue((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const toggleRegenVideo = useCallback((id: string) => {
    setRegenQueue((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const handleRegenNow = async () => {
    if (regenQueue.length === 0) return;
    setRegenSubmitting(true);
    const queue = [...regenQueue];
    const results: { id: string; success: boolean }[] = [];
    setRegenProgress({ done: 0, total: queue.length, results });
    try {
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        try {
          await regenMetadata({ videoId: id as Id<"videos">, autoMarkReady: false });
          results.push({ id, success: true });
        } catch {
          results.push({ id, success: false });
        }
        setRegenProgress({ done: i + 1, total: queue.length, results: [...results] });
      }
      setRegenQueue([]);
    } finally {
      setRegenSubmitting(false);
    }
  };

  const handleScheduleMetadata = async () => {
    if (metaQueue.length === 0 || !metaStartTime) return;
    setMetaSubmitting(true);
    const queue = [...metaQueue];
    setMetaProgress({ done: 0, total: queue.length });
    try {
      const startMs = new Date(metaStartTime).getTime();
      for (let i = 0; i < queue.length; i++) {
        try {
          await scheduleMetadata({
            id: queue[i] as Id<"videos">,
            scheduledAt: startMs + i * metaIntervalMin * 60_000,
          });
          setMetaQueue((prev) => prev.filter((x) => x !== queue[i]));
        } catch (e) {
          console.error(`Failed to schedule video ${i + 1}:`, e);
        }
        setMetaProgress({ done: i + 1, total: queue.length });
      }
      setMetaStartTime("");
      setShowForm(false);
    } finally {
      setMetaSubmitting(false);
      setMetaProgress(null);
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
      {/* Week at a glance */}
      <div className="mb-6 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">This Week</h2>
          <Link
            href={"/content-calendar" as Route}
            className="flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <CalendarDays className="h-3.5 w-3.5" />
            View Full Calendar
          </Link>
        </div>
        <WeekStrip scheduledTimestamps={scheduledTimestamps} />
      </div>

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
            <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-full sm:w-fit overflow-x-auto">
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
              <button
                type="button"
                onClick={() => setMode("metadata")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === "metadata"
                    ? "bg-background shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Wand2 className="h-3.5 w-3.5" />
                Metadata
              </button>
            </div>
          </CardHeader>

          <CardContent className="pt-3">
            {mode === "metadata" ? (
              /* ── Metadata generation ── */
              <div className="space-y-5">
                {/* Schedule / Now toggle */}
                <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-full sm:w-fit overflow-x-auto text-xs">
                  <button
                    type="button"
                    onClick={() => setMetaMode("schedule")}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${metaMode === "schedule" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    <CalendarClock className="h-3 w-3" /> Schedule
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMetaMode("now"); setRegenProgress(null); }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-medium transition-colors ${metaMode === "now" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    <RefreshCw className="h-3 w-3" /> Regenerate Now
                  </button>
                </div>

                {metaMode === "now" ? (
                  /* ── Regenerate Now panel ── */
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Immediately regenerate AI metadata for selected videos using the improved VidIQ-style prompt, works on both <strong>draft</strong> and <strong>ready</strong> videos. Existing titles and tags are replaced.
                    </p>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium">
                          Videos
                          <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                            ({regenEligibleVideos.length} eligible)
                          </span>
                        </label>
                        <div className="flex gap-2 text-xs">
                          <button type="button" onClick={() => setRegenQueue(regenEligibleVideos.map((v) => v._id))} className="text-primary hover:underline">
                            Select all
                          </button>
                          {regenQueue.length > 0 && (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <button type="button" onClick={() => setRegenQueue([])} className="text-muted-foreground hover:text-foreground">Clear</button>
                            </>
                          )}
                        </div>
                      </div>

                      {regenEligibleVideos.length === 0 ? (
                        <div className="border rounded-md flex items-center justify-center h-24 text-sm text-muted-foreground">
                          No draft or ready videos found
                        </div>
                      ) : (
                        <div className="border rounded-md divide-y max-h-52 overflow-y-auto">
                          {regenEligibleVideos.map((v) => {
                            const checked = regenQueue.includes(v._id);
                            const result = regenProgress?.results.find(r => r.id === v._id);
                            return (
                              <button
                                key={v._id}
                                type="button"
                                onClick={() => !regenSubmitting && toggleRegenVideo(v._id)}
                                disabled={regenSubmitting}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors ${checked ? "bg-primary/5" : ""}`}
                              >
                                {result ? (
                                  result.success
                                    ? <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                                    : <XCircle className="h-4 w-4 text-destructive shrink-0" />
                                ) : checked
                                  ? <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                                  : <Square className="h-4 w-4 text-muted-foreground shrink-0" />
                                }
                                <span className="text-sm truncate flex-1">{(v as any).aiTitle ?? v.title}</span>
                                <span className={`text-xs shrink-0 ${v.status === "ready" ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
                                  {v.status}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {regenProgress && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Processing {regenProgress.done}/{regenProgress.total}</span>
                          <span>{regenProgress.results.filter(r => r.success).length} succeeded · {regenProgress.results.filter(r => !r.success).length} failed</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all duration-300"
                            style={{ width: `${(regenProgress.done / regenProgress.total) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button onClick={handleRegenNow} disabled={regenQueue.length === 0 || regenSubmitting}>
                        {regenSubmitting ? (
                          <><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Regenerating {regenProgress?.done ?? 0}/{regenProgress?.total ?? regenQueue.length}…</>
                        ) : (
                          <><RefreshCw className="mr-2 h-4 w-4" />Regenerate {regenQueue.length > 0 ? `${regenQueue.length} Video${regenQueue.length !== 1 ? "s" : ""}` : "Selected"}</>
                        )}
                      </Button>
                      {regenProgress && !regenSubmitting && (
                        <Button variant="outline" onClick={() => { setRegenProgress(null); setRegenQueue([]); }}>Done</Button>
                      )}
                    </div>
                  </div>
                ) : (
                /* ── Schedule panel (existing) ── */
                <div className="space-y-5">
                <p className="text-sm text-muted-foreground">
                  Schedule AI metadata generation for draft videos. Each video is analyzed, titled, and automatically marked <strong>Ready</strong>, you get a Discord notification for each one.
                </p>
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
                  <span className="shrink-0 mt-0.5">⚠</span>
                  <span>Schedule metadata to finish <strong>before</strong> your publishing window. If both run at the same hour, the publish job finds zero ready videos and skips.</span>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium">
                      Unscheduled Drafts
                      <span className="ml-1.5 font-normal text-muted-foreground text-xs">
                        ({draftVideos.length} to schedule
                        {pendingMetadataVideos.length > 0 && `, ${pendingMetadataVideos.length} already queued`})
                      </span>
                    </label>
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => setMetaQueue(draftVideos.map((v) => v._id))}
                        className="text-primary hover:underline"
                      >
                        Select all
                      </button>
                      {metaQueue.length > 0 && (
                        <>
                          <span className="text-muted-foreground">·</span>
                          <button
                            type="button"
                            onClick={() => setMetaQueue([])}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            Clear
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {draftVideos.length === 0 && pendingMetadataVideos.length === 0 ? (
                    <div className="border rounded-md flex items-center justify-center h-32 text-sm text-muted-foreground">
                      No draft videos. Upload some first
                    </div>
                  ) : draftVideos.length === 0 ? (
                    <div className="border rounded-md flex items-center justify-center h-16 text-sm text-muted-foreground">
                      All drafts are already queued for metadata
                    </div>
                  ) : (
                    <div className="border rounded-md divide-y max-h-52 overflow-y-auto">
                      {draftVideos.map((v) => {
                        const checked = metaQueue.includes(v._id);
                        const pos = metaQueue.indexOf(v._id);
                        return (
                          <button
                            key={v._id}
                            type="button"
                            onClick={() => toggleMetaVideo(v._id)}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors ${checked ? "bg-primary/5" : ""}`}
                          >
                            {checked
                              ? <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                              : <Square className="h-4 w-4 text-muted-foreground shrink-0" />
                            }
                            <span className="text-sm truncate flex-1">
                              {(v as any).aiTitle ?? v.title}
                            </span>
                            {checked && (
                              <span className="ml-auto text-xs text-primary font-medium">#{pos + 1}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {pendingMetadataVideos.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pt-1">
                        Already Queued ({pendingMetadataVideos.length})
                      </p>
                      <div className="border rounded-md divide-y max-h-40 overflow-y-auto border-amber-500/30 bg-amber-500/5">
                        {pendingMetadataVideos.map((v) => {
                          const scheduledAt = v.metadataScheduledAt!;
                          return (
                            <div key={v._id} className="flex items-center gap-3 px-3 py-2">
                              <Wand2 className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                              <span className="text-sm truncate flex-1 text-muted-foreground">
                                {(v as any).aiTitle ?? v.title}
                              </span>
                              <span className="text-xs text-amber-600 dark:text-amber-400 shrink-0">
                                {formatDistanceToNow(scheduledAt, { addSuffix: true })}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid sm:grid-cols-2 gap-4 pt-1 border-t">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Start generating at</label>
                    <input
                      type="datetime-local"
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      min={minDatetimeValue()}
                      value={metaStartTime}
                      onChange={(e) => setMetaStartTime(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Gap between each video</label>
                    <div className="flex flex-wrap gap-1.5">
                      {META_INTERVALS.map((int) => (
                        <button
                          key={int.value}
                          type="button"
                          onClick={() => setMetaIntervalMin(int.value)}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                            metaIntervalMin === int.value
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

                {metaQueue.length > 0 && metaStartTime && (
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                      Generation Preview
                    </p>
                    <div className="space-y-1.5 max-h-36 overflow-y-auto">
                      {metaQueue.map((id, i) => {
                        const v = videoMap.get(id);
                        const time = new Date(metaStartTime).getTime() + i * metaIntervalMin * 60_000;
                        return (
                          <div key={id} className="flex items-center justify-between gap-3 text-xs">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-muted-foreground font-mono w-4 shrink-0 tabular-nums">{i + 1}.</span>
                              <span className="truncate">{(v as any)?.aiTitle ?? (v as any)?.title}</span>
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

                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={handleScheduleMetadata}
                    disabled={metaQueue.length === 0 || !metaStartTime || metaSubmitting}
                  >
                    {metaSubmitting ? (
                      <>
                        <LoadingSpinner size="sm" />
                        <span className="ml-2">
                          {metaProgress
                            ? `Scheduling ${metaProgress.done}/${metaProgress.total}…`
                            : "Scheduling…"}
                        </span>
                      </>
                    ) : (
                      <>
                        <Wand2 className="mr-2 h-4 w-4" />
                        {metaQueue.length > 0
                          ? `Schedule Metadata for ${metaQueue.length} Video${metaQueue.length !== 1 ? "s" : ""}`
                          : "Schedule Metadata"}
                      </>
                    )}
                  </Button>
                  <Button variant="outline" onClick={() => { setShowForm(false); setMetaQueue([]); }}>
                    Cancel
                  </Button>
                </div>
                </div>
                )}
              </div>
            ) : mode === "single" ? (
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
              /* ── Auto-publish queue drain ── */
              <div className="space-y-5">
                {isAutoActive ? (
                  /* Active state */
                  <div className="space-y-4">
                    <div className="flex items-center gap-3 p-4 rounded-lg border border-primary/30 bg-primary/5">
                      <div className="flex-1 space-y-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">Auto-Publish Active</span>
                          <Badge className="bg-primary/15 text-primary border-primary/30 text-xs">Running</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground break-words">
                          Up to {userSettings?.autoPublishCount ?? 1} video{(userSettings?.autoPublishCount ?? 1) !== 1 ? "s" : ""}{" "}
                          {(userSettings as any)?.autoPublishTimeSlots?.length
                            ? <>at {[...(userSettings as any).autoPublishTimeSlots].sort((a: number, b: number) => a - b).map((h: number) => ALL_HOURS.find((x) => x.hour === h)?.label).join(", ")} EAT</>
                            : <>every {INTERVALS.find((i) => i.value === Math.round((userSettings?.autoPublishIntervalMs ?? 0) / 60_000))?.label ?? "interval"}</>
                          }{" "}
                          · <span className="capitalize">{userSettings?.autoPublishPrivacy ?? "public"}</span>
                          {" "}· {schedulableVideos.length} ready now
                        </p>
                        {userSettings?.autoPublishNextAt && (
                          <p className="text-xs text-muted-foreground">
                            Next run {formatDistanceToNow(userSettings.autoPublishNextAt, { addSuffix: true })}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleStopAutoPublish}
                        disabled={autoSubmitting}
                        className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/5"
                      >
                        {autoSubmitting ? <LoadingSpinner size="sm" /> : <X className="h-3.5 w-3.5 mr-1" />}
                        Stop
                      </Button>
                    </div>

                    {schedulableVideos.length === 0 ? (
                      <p className="text-sm text-center text-muted-foreground py-3">
                        No ready videos yet. The metadata cron will fill this pool as it processes your drafts.
                      </p>
                    ) : (
                      <div className="border rounded-md divide-y max-h-52 overflow-y-auto">
                        {schedulableVideos.map((v, i) => (
                          <div key={v._id} className="flex items-center gap-3 px-3 py-2.5">
                            <span className="text-xs text-muted-foreground font-mono w-4 shrink-0 tabular-nums">{i + 1}</span>
                            <span className="text-sm truncate flex-1">{(v as any).aiTitle ?? v.title}</span>
                            <Badge variant="outline" className="text-xs shrink-0 capitalize">
                              {(v as any).privacyStatus ?? userSettings?.autoPublishPrivacy ?? "public"}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  /* Setup form */
                  <>
                    <p className="text-sm text-muted-foreground">
                      Set a recurring schedule and ReelCast automatically picks your oldest <strong>ready</strong> videos and publishes them. No manual selection needed. The metadata cron fills the pool, this cron drains it.
                    </p>

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Audience Timezone</label>
                        <p className="text-xs text-muted-foreground">
                          Where most of your viewers are. The first engagement hour matters most for the algorithm.
                        </p>
                        <select
                          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          value={tzOffset}
                          onChange={(e) => setTzOffset(Number(e.target.value))}
                        >
                          {TIMEZONE_OPTIONS.map((tz) => (
                            <option key={tz.value} value={tz.value}>
                              {tz.label}: {tz.desc}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Videos per slot</label>
                        <p className="text-xs text-muted-foreground">
                          How many videos to publish at each time slot.
                        </p>
                        <div className="flex gap-1.5 pt-1">
                          {[1, 2, 3, 5].map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setAutoCount(n)}
                              className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors min-w-[2.5rem] ${
                                autoCount === n
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : "bg-background border-input hover:border-primary/50 hover:bg-muted"
                              }`}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {suggestedTimes?.suggestedTimes && suggestedTimes.suggestedTimes.length > 0 && (
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-primary" />
                            Your Best Times to Post
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            Based on {suggestedTimes.totalVideosAnalysed} published videos — ranked by CTR and views.
                          </p>
                        </CardHeader>
                        <CardContent>
                          <div className="flex flex-col gap-2">
                            {suggestedTimes.suggestedTimes.map((slot, i) => (
                              <div key={slot.hourUtc} className="flex items-center justify-between rounded-md border px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-medium text-muted-foreground w-4">{i + 1}</span>
                                  <div>
                                    <p className="text-sm font-medium">
                                      {slot.hourEat === 0 ? "12 AM" : slot.hourEat < 12 ? `${slot.hourEat} AM` : slot.hourEat === 12 ? "12 PM" : `${slot.hourEat - 12} PM`} EAT
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      CTR {(slot.avgCtr * 100).toFixed(1)}% · {slot.avgViews.toLocaleString()} avg views
                                    </p>
                                  </div>
                                </div>
                                <span className={[
                                  "text-xs font-medium px-2 py-0.5 rounded-full",
                                  slot.confidence === "high"
                                    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400"
                                    : "bg-muted text-muted-foreground",
                                ].join(" ")}>
                                  {slot.confidence === "high" ? "High confidence" : "Low confidence"}
                                </span>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium">
                          Posting Times
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            {TIMEZONE_OPTIONS.find((t) => t.value === tzOffset)?.label ?? "UTC+3"}
                          </span>
                        </label>
                        <button
                          type="button"
                          onClick={() => setShowAllHours((p) => !p)}
                          className="text-xs text-primary hover:underline"
                        >
                          {showAllHours ? "Show optimal only" : "Custom hours"}
                        </button>
                      </div>

                      {!showAllHours ? (
                        <div className="space-y-1.5">
                          <p className="text-xs text-muted-foreground">Research-backed peak times for YouTube Shorts engagement:</p>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {OPTIMAL_SLOTS.map(({ hour, label, reason }) => {
                              const on = timeSlots.includes(hour);
                              return (
                                <button
                                  key={hour}
                                  type="button"
                                  onClick={() => setTimeSlots((prev) =>
                                    on ? prev.filter((h) => h !== hour) : [...prev, hour]
                                  )}
                                  className={`flex flex-col items-center gap-0.5 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
                                    on
                                      ? "bg-primary text-primary-foreground border-primary"
                                      : "bg-background border-input hover:border-primary/50 hover:bg-muted"
                                  }`}
                                >
                                  <span className="text-sm font-semibold">{label}</span>
                                  <span className={`font-normal ${on ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{reason}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {ALL_HOURS.map(({ hour, label }) => {
                            const on = timeSlots.includes(hour);
                            const isOptimal = OPTIMAL_SLOTS.some((s) => s.hour === hour);
                            return (
                              <button
                                key={hour}
                                type="button"
                                onClick={() => setTimeSlots((prev) =>
                                  on ? prev.filter((h) => h !== hour) : [...prev, hour]
                                )}
                                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors relative ${
                                  on
                                    ? "bg-primary text-primary-foreground border-primary"
                                    : isOptimal
                                    ? "bg-primary/5 border-primary/30 hover:border-primary/60"
                                    : "bg-background border-input hover:border-primary/50 hover:bg-muted"
                                }`}
                              >
                                {label}
                                {isOptimal && !on && <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-primary" />}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {timeSlots.length === 0 && (
                        <p className="text-xs text-destructive">Select at least one posting time.</p>
                      )}
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

                    {timeSlots.length > 0 && (
                      <div className="bg-muted/50 rounded-lg px-4 py-3 text-sm space-y-1">
                        <div>
                          <span className="text-muted-foreground">First post </span>
                          <span className="font-medium">
                            {format(nextEATSlot(timeSlots, tzOffset), "MMM d 'at' h:mm a")}
                          </span>
                          <span className="text-muted-foreground"> {TIMEZONE_OPTIONS.find((t) => t.value === tzOffset)?.label ?? "UTC"}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Slots: </span>
                          <span className="font-medium">
                            {[...timeSlots].sort((a, b) => a - b).map((h) =>
                              ALL_HOURS.find((x) => x.hour === h)?.label
                            ).join(", ")}
                          </span>
                          <span className="text-muted-foreground"> · up to </span>
                          <span className="font-medium">{autoCount} video{autoCount !== 1 ? "s" : ""} per slot</span>
                          <span className="text-muted-foreground"> · </span>
                          <span className="font-medium capitalize">{autoPrivacy}</span>
                          {schedulableVideos.length > 0 && (
                            <span className="text-muted-foreground"> · {schedulableVideos.length} ready now</span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2 pt-1">
                      <Button
                        onClick={handleStartAutoPublish}
                        disabled={timeSlots.length === 0 || autoSubmitting}
                      >
                        {autoSubmitting ? (
                          <>
                            <LoadingSpinner size="sm" />
                            <span className="ml-2">Starting…</span>
                          </>
                        ) : (
                          <>
                            <Zap className="mr-2 h-4 w-4" />
                            Start Auto-Publish
                          </>
                        )}
                      </Button>
                      <Button variant="outline" onClick={() => setShowForm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </>
                )}
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
