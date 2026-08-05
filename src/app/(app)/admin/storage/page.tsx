"use client";

import { useQuery } from "convex/react";
import { HardDrive } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export default function AdminStoragePage() {
  const breakdown = useQuery(api.admin.storage.getPerUserBreakdown);

  if (breakdown === undefined) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  const totalBytes = breakdown.reduce((s, r) => s + r.totalBytes, 0);

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Storage</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Platform-wide file storage consumed by uploaded videos.
        </p>
      </div>

      {/* Total storage card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-muted-foreground" />
            Total Storage
          </CardTitle>
          <CardDescription>
            Summed across all videos currently stored on the platform.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-4xl font-bold">{formatBytes(totalBytes)}</p>
          <p className="text-sm text-muted-foreground mt-1">
            Across {breakdown.reduce((s, r) => s + r.videoCount, 0)} video
            {breakdown.reduce((s, r) => s + r.videoCount, 0) !== 1 ? "s" : ""}{" "}
            from {breakdown.length} user{breakdown.length !== 1 ? "s" : ""}
          </p>
        </CardContent>
      </Card>

      {/* Per-user breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Per-user Breakdown</CardTitle>
          <CardDescription>Sorted by storage usage, highest first.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {breakdown.length === 0 ? (
            <p className="px-6 py-8 text-sm text-muted-foreground text-center">
              No storage data available.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-4 py-3 font-medium text-muted-foreground">Rank</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">User</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Plan</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Videos</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Storage</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">% of total</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((row, i) => {
                    const pct = totalBytes > 0
                      ? Math.min(100, Math.round((row.totalBytes / totalBytes) * 100))
                      : 0;
                    return (
                      <tr key={row.userId} className="border-b last:border-0">
                        <td className="px-4 py-3 text-muted-foreground">{i + 1}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium truncate max-w-[180px]">
                            {row.name ?? row.email}
                          </p>
                          {row.name && (
                            <p className="text-xs text-muted-foreground truncate max-w-[180px]">
                              {row.email}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            className={cn(
                              "text-xs",
                              row.plan === "pro"
                                ? "bg-blue-500 text-white hover:bg-blue-600"
                                : "bg-muted text-muted-foreground hover:bg-muted"
                            )}
                          >
                            {row.plan ?? "free"}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 font-mono">{row.videoCount}</td>
                        <td className="px-4 py-3 font-mono">{formatBytes(row.totalBytes)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="h-2 w-32 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground">{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
