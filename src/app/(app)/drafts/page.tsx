"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useQuery, useMutation, useAction } from "convex/react";
import { Film, Plus, Search, SortAsc, CheckCircle2, Loader2, AlertTriangle, Timer } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { VideoCard } from "@/components/video-card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import type { Video as VideoType } from "@/types/video";
import type { VideoStatus } from "@/lib/constants";


type SortOption = "newest" | "oldest" | "name-az" | "name-za" | "size-desc" | "size-asc";

function nextSlotAfter(slots: number[], afterMs: number, tzOffsetHours: number): number {
  const TZ_MS = tzOffsetHours * 3_600_000;
  const shifted = new Date(afterMs + TZ_MS);
  const msSinceMidnight =
    shifted.getUTCHours() * 3_600_000 +
    shifted.getUTCMinutes() * 60_000 +
    shifted.getUTCSeconds() * 1_000 +
    shifted.getUTCMilliseconds();
  const midnight = afterMs - msSinceMidnight;
  const sorted = [...slots].sort((a, b) => a - b);
  for (const h of sorted) {
    const slotMs = midnight + h * 3_600_000;
    if (slotMs > afterMs) return slotMs;
  }
  return midnight + 24 * 3_600_000 + sorted[0] * 3_600_000;
}

const STATUS_PILLS: { value: VideoStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
  { value: "published", label: "Published" },
  { value: "scheduled", label: "Scheduled" },
  { value: "generating", label: "Generating" },
  { value: "failed", label: "Failed" },
];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name-az", label: "Name A→Z" },
  { value: "name-za", label: "Name Z→A" },
  { value: "size-desc", label: "Largest" },
  { value: "size-asc", label: "Smallest" },
];

export default function DraftsPage() {
  const videos            = useQuery(api.videos.list);
  const userSettings      = useQuery(api.settings.get);
  const bulkMarkReady         = useMutation(api.videos.bulkMarkDraftsReady);
  const bulkSwitchToVideo     = useMutation(api.videos.bulkSwitchLongVideosToVideo);
  const backfillDurations     = useAction(api.actions.backfillDurations.backfillDurations);

  const [marking, setMarking]             = useState(false);
  const [markResult, setMarkResult]       = useState<number | null>(null);
  const [scanning, setScanning]           = useState(false);
  const [scanResult, setScanResult]       = useState<{ updated: number; switched: number; total: number } | null>(null);
  const [switching, setSwitching]         = useState(false);
  const [switchResult, setSwitchResult]   = useState<number | null>(null);

  const draftCount = useMemo(
    () => (videos ?? []).filter((v) => v.status === "draft").length,
    [videos]
  );

  // Videos >60s that are not explicitly set to publish as Video — at risk of Content ID block
  const atRiskCount = useMemo(
    () =>
      (videos ?? []).filter(
        (v) =>
          (v as any).duration > 60 &&
          (v as any).publishAs !== "video" &&
          v.status !== "published"
      ).length,
    [videos]
  );

  const handleBulkMarkReady = async () => {
    setMarking(true);
    setMarkResult(null);
    try {
      const result = await bulkMarkReady({});
      setMarkResult(result.count);
    } catch (e) {
      console.error("Bulk mark ready failed:", e);
    } finally {
      setMarking(false);
    }
  };

  const handleScanDurations = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const result = await backfillDurations({});
      setScanResult({ updated: result.updated, switched: result.switched, total: result.total });
    } catch (e) {
      console.error("Duration scan failed:", e);
    } finally {
      setScanning(false);
    }
  };

  const handleBulkSwitchToVideo = async () => {
    setSwitching(true);
    setSwitchResult(null);
    try {
      const result = await bulkSwitchToVideo({});
      setSwitchResult(result.switched);
    } catch (e) {
      console.error("Bulk switch failed:", e);
    } finally {
      setSwitching(false);
    }
  };

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<VideoStatus | "all">("all");
  const [sort, setSort] = useState<SortOption>("newest");

  const typedVideos = useMemo(
    () => (videos ?? []) as VideoType[],
    [videos]
  );

  // Estimated auto-publish time per ready video (oldest-first queue position)
  const estimatedPublishMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!userSettings?.autoPublishEnabled || !userSettings.autoPublishNextAt) return map;
    const nextAt     = userSettings.autoPublishNextAt;
    const intervalMs = userSettings.autoPublishIntervalMs ?? 6 * 3_600_000;
    const count      = userSettings.autoPublishCount ?? 1;
    const timeSlots  = (userSettings as any).autoPublishTimeSlots as number[] | undefined;
    const tzOffset   = ((userSettings as any).autoPublishTimezoneOffset as number | undefined) ?? 3;

    const readyVideos = (videos ?? [])
      .filter((v) => v.status === "ready")
      .sort((a, b) => a._creationTime - b._creationTime);

    if (timeSlots?.length) {
      // Pre-compute each run's wall-clock slot time so we only iterate slots once
      const totalRuns = Math.ceil(readyVideos.length / count);
      const slotTimes: number[] = [nextAt];
      for (let r = 1; r < totalRuns; r++) {
        slotTimes.push(nextSlotAfter(timeSlots, slotTimes[r - 1], tzOffset));
      }
      readyVideos.forEach((v, i) => {
        map.set(v._id, slotTimes[Math.floor(i / count)]);
      });
    } else {
      readyVideos.forEach((v, i) => {
        map.set(v._id, nextAt + Math.floor(i / count) * intervalMs);
      });
    }
    return map;
  }, [videos, userSettings]);

  const statusCounts = useMemo(() => {
    const counts: Partial<Record<VideoStatus | "all", number>> = { all: typedVideos.length };
    for (const v of typedVideos) {
      counts[v.status] = (counts[v.status] ?? 0) + 1;
    }
    return counts;
  }, [typedVideos]);

  const processedVideos = useMemo(() => {
    let result = typedVideos;

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((v) =>
        (v.aiTitle ?? v.title).toLowerCase().includes(q)
      );
    }

    if (statusFilter !== "all") {
      result = result.filter((v) => v.status === statusFilter);
    }

    result = [...result].sort((a, b) => {
      switch (sort) {
        case "newest":
          return b._creationTime - a._creationTime;
        case "oldest":
          return a._creationTime - b._creationTime;
        case "name-az":
          return (a.aiTitle ?? a.title).localeCompare(b.aiTitle ?? b.title);
        case "name-za":
          return (b.aiTitle ?? b.title).localeCompare(a.aiTitle ?? a.title);
        case "size-desc":
          return b.rawFileSize - a.rawFileSize;
        case "size-asc":
          return a.rawFileSize - b.rawFileSize;
        default:
          return 0;
      }
    });

    return result;
  }, [typedVideos, search, statusFilter, sort]);

  if (videos === undefined) {
    return <div className="flex h-full items-center justify-center"><LoadingSpinner /></div>;
  }

  const visiblePills = STATUS_PILLS.filter(
    (p) => p.value === "all" || (statusCounts[p.value as VideoStatus] ?? 0) > 0
  );

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Video Library</h1>
          <p className="text-muted-foreground">Manage your uploads, drafts, and published content.</p>
        </div>
        <Link href="/upload">
          <Button>
            <Plus className="mr-2 h-4 w-4" /> New Upload
          </Button>
        </Link>
      </div>

      {/* Bulk mark ready banner */}
      {draftCount > 0 && !markResult && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <CheckCircle2 className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-700 dark:text-amber-300">
              <span className="font-semibold">{draftCount} draft video{draftCount !== 1 ? "s" : ""}</span>
              {" "}with existing metadata — mark them all as Ready to join the auto-publish queue.
            </p>
          </div>
          <button
            type="button"
            onClick={handleBulkMarkReady}
            disabled={marking}
            className="shrink-0 flex items-center gap-1.5 rounded-md bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white text-xs font-semibold px-3 py-1.5 transition-colors"
          >
            {marking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {marking ? "Marking…" : "Mark all Ready"}
          </button>
        </div>
      )}
      {markResult !== null && (
        <div className="flex items-center gap-2.5 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {markResult} video{markResult !== 1 ? "s" : ""} marked as Ready and added to the auto-publish queue.
        </div>
      )}

      {/* Scan durations banner — shown when videos have no duration data yet */}
      {!scanning && !scanResult && (videos ?? []).some((v) => !(v as any).duration && !(v as any).cloudinaryDeletedAt) && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-muted bg-muted/40 px-4 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Timer className="h-4 w-4 text-muted-foreground shrink-0" />
            <p className="text-sm text-muted-foreground">
              Some videos are missing duration data. Scan Cloudinary to extract it and identify videos that may cause copyright issues.
            </p>
          </div>
          <button
            type="button"
            onClick={handleScanDurations}
            disabled={scanning}
            className="shrink-0 flex items-center gap-1.5 rounded-md border border-input hover:bg-muted text-foreground text-xs font-semibold px-3 py-1.5 transition-colors"
          >
            <Timer className="h-3.5 w-3.5" />
            Scan durations
          </button>
        </div>
      )}
      {scanning && (
        <div className="flex items-center gap-2.5 rounded-lg border border-muted bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          Scanning Cloudinary for video durations… this may take a moment.
        </div>
      )}
      {scanResult !== null && (
        <div className="flex items-center gap-2.5 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            Scan complete — {scanResult.updated} video{scanResult.updated !== 1 ? "s" : ""} updated
            {scanResult.switched > 0 && (
              <>, <strong>{scanResult.switched} automatically switched to Video mode</strong> (over 60s)</>
            )}
            {scanResult.total === 0 && " — all videos already had duration data"}.
          </span>
        </div>
      )}

      {/* Copyright risk banner — videos >60s that will be uploaded as Shorts */}
      {atRiskCount > 0 && switchResult === null && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-orange-500/30 bg-orange-500/10 px-4 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400 shrink-0" />
            <p className="text-sm text-orange-700 dark:text-orange-300">
              <span className="font-semibold">{atRiskCount} video{atRiskCount !== 1 ? "s" : ""}</span>
              {" "}over 60s — risk YouTube Content ID block as Shorts.
            </p>
          </div>
          <button
            type="button"
            onClick={handleBulkSwitchToVideo}
            disabled={switching}
            className="shrink-0 flex items-center gap-1.5 rounded-md bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white text-xs font-semibold px-3 py-1.5 transition-colors"
          >
            {switching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {switching ? "Switching…" : "Switch all to Video"}
          </button>
        </div>
      )}
      {switchResult !== null && (
        <div className="flex items-center gap-2.5 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {switchResult} video{switchResult !== 1 ? "s" : ""} switched to Video mode — they&apos;ll no longer upload as Shorts.
        </div>
      )}

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Search videos…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-9 rounded-md border border-input bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <SortAsc className="h-4 w-4 text-muted-foreground shrink-0" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Status filter pills */}
      {typedVideos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {visiblePills.map((pill) => {
            const count = statusCounts[pill.value] ?? 0;
            const isActive = statusFilter === pill.value;
            return (
              <Button
                key={pill.value}
                size="sm"
                variant={isActive ? "default" : "outline"}
                onClick={() => setStatusFilter(pill.value)}
              >
                {pill.label}
                <span className="ml-1.5 text-xs opacity-70">({count})</span>
              </Button>
            );
          })}
        </div>
      )}

      {/* Results count */}
      {typedVideos.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {processedVideos.length} video{processedVideos.length !== 1 ? "s" : ""}
        </p>
      )}

      {/* Grid or empty states */}
      {typedVideos.length === 0 ? (
        <EmptyState
          icon={Film}
          title="Your library is empty"
          description="Upload your first piece of raw footage to get started."
          action={
            <Link href="/upload">
              <Button variant="outline" className="mt-4">
                <Plus className="mr-2 h-4 w-4" /> Upload Video
              </Button>
            </Link>
          }
        />
      ) : processedVideos.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No videos match your filters"
          description={
            search.trim()
              ? `No videos found for "${search}". Try a different search term or clear your filters.`
              : "No videos match the selected status filter."
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {processedVideos.map((video) => (
            <VideoCard
              key={video._id}
              video={video}
              estimatedPublishAt={estimatedPublishMap.get(video._id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
