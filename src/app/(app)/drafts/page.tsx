"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { Film, Plus, Search, SortAsc } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { VideoCard } from "@/components/video-card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import type { Video as VideoType } from "@/types/video";
import type { VideoStatus } from "@/lib/constants";

type SortOption = "newest" | "oldest" | "name-az" | "name-za" | "size-desc" | "size-asc";

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
  const videos = useQuery(api.videos.list);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<VideoStatus | "all">("all");
  const [sort, setSort] = useState<SortOption>("newest");

  const typedVideos = useMemo(
    () => (videos ?? []) as VideoType[],
    [videos]
  );

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
            <VideoCard key={video._id} video={video} />
          ))}
        </div>
      )}
    </div>
  );
}
