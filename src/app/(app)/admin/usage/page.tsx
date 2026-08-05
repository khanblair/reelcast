"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function formatLimit(limit: number) {
  return limit >= 999999 ? "∞" : String(limit);
}

export default function AdminUsagePage() {
  const overview = useQuery(api.admin.usageLedger.getOverview);

  const currentMonth = new Date().toISOString().slice(0, 7);

  if (overview === undefined) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  const freeCount = overview.filter((r) => r.plan === "free").length;
  const proCount = overview.filter((r) => r.plan === "pro").length;
  const atLimitCount = overview.filter(
    (r) =>
      r.limits.videosUploaded < 999999 &&
      r.videosUploaded >= r.limits.videosUploaded
  ).length;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Usage &mdash; {currentMonth}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Monthly usage ledger for all users.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Free Users</p>
            <p className="text-2xl font-bold">{freeCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Pro Users</p>
            <p className="text-2xl font-bold">{proCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">At Upload Limit</p>
            <p className="text-2xl font-bold">{atLimitCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Usage table */}
      <Card>
        <CardContent className="p-0">
          {overview.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground text-center">
              No usage data for this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-4 py-3 font-medium text-muted-foreground">User</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Plan</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Uploads (X/limit)</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Metadata (X/limit)</th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">Veo (X/limit)</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.map((row) => {
                    const atLimit =
                      (row.limits.videosUploaded < 999999 && row.videosUploaded >= row.limits.videosUploaded) ||
                      (row.limits.metadataGenerated < 999999 && row.metadataGenerated >= row.limits.metadataGenerated) ||
                      (row.limits.veoGenerated < 999999 && row.veoGenerated >= row.limits.veoGenerated);

                    return (
                      <tr
                        key={`${row.userId}-${row.month}`}
                        className={cn(
                          "border-b last:border-0",
                          atLimit && "bg-red-50 dark:bg-red-950/20"
                        )}
                      >
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
                        <td className="px-4 py-3 font-mono text-xs">
                          {row.videosUploaded} / {formatLimit(row.limits.videosUploaded)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {row.metadataGenerated} / {formatLimit(row.limits.metadataGenerated)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {row.veoGenerated} / {formatLimit(row.limits.veoGenerated)}
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
