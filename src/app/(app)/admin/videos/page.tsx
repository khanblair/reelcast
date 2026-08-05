"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTimeEAT } from "@/lib/eat";
import { Trash2, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Id } from "../../../../../convex/_generated/dataModel";

type StatusFilter = "all" | "draft" | "ready" | "scheduled" | "published" | "failed";

const STATUS_TABS: StatusFilter[] = ["all", "draft", "ready", "scheduled", "published", "failed"];

function statusBadgeClass(status: string) {
  switch (status) {
    case "published": return "bg-green-500 text-white hover:bg-green-600";
    case "ready":     return "bg-blue-500 text-white hover:bg-blue-600";
    case "scheduled": return "bg-yellow-500 text-white hover:bg-yellow-600";
    case "failed":    return "bg-red-500 text-white hover:bg-red-600";
    case "draft":     return "bg-muted text-muted-foreground hover:bg-muted";
    default:          return "bg-muted text-muted-foreground hover:bg-muted";
  }
}

function formatBytes(bytes: number) {
  if (!bytes) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

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

export default function AdminVideosPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const videos = useQuery(api.admin.videos.listAll, { limit: 100 });
  const adminDelete = useMutation(api.admin.videos.adminDelete);

  const filtered =
    videos === undefined
      ? undefined
      : statusFilter === "all"
      ? videos
      : (videos as Video[]).filter((v) => v.status === statusFilter);

  async function handleDelete(videoId: string) {
    if (!window.confirm("Delete this video?")) return;
    await adminDelete({ videoId: videoId as Id<"videos"> });
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Videos</h1>
        <p className="text-muted-foreground text-sm mt-1">
          All videos across all users.
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 border-b overflow-x-auto">
        {STATUS_TABS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px whitespace-nowrap",
              statusFilter === s
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered === undefined ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground text-center">
              No videos found.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-4 py-3 font-medium text-muted-foreground">Title</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">User</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Size</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Published / Scheduled</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(filtered as Video[]).map((video) => (
                    <tr key={video._id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-3 truncate max-w-[200px]">
                        {video.title ?? "Untitled"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground truncate max-w-[160px]">
                        {video.userName ?? video.userEmail ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={cn("text-xs capitalize", statusBadgeClass(video.status))}>
                          {video.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {video.rawFileSize ? formatBytes(video.rawFileSize) : "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                        {video.publishedAt
                          ? formatDateTimeEAT(video.publishedAt)
                          : video.scheduledPublishAt
                          ? formatDateTimeEAT(video.scheduledPublishAt)
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {video.publishedVideoId && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => window.open(`https://youtube.com/watch?v=${video.publishedVideoId}`, "_blank")}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => handleDelete(video._id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
