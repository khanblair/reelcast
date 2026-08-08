"use client";

import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type PlanFilter = "all" | "free" | "pro" | "elite";
type LimitFilter = "all" | "at_limit";

function formatLimit(limit: number) {
  return limit >= 999999 ? "∞" : String(limit);
}

export default function AdminUsagePage() {
  const overview = useQuery(api.admin.usageLedger.getOverview);

  const [planFilter, setPlanFilter] = useState<PlanFilter>("all");
  const [limitFilter, setLimitFilter] = useState<LimitFilter>("all");

  const currentMonth = new Date().toISOString().slice(0, 7);

  const filtered = useMemo(() => {
    if (!overview) return [];
    return overview.filter((r) => {
      if (planFilter !== "all" && (r.plan ?? "free") !== planFilter) return false;
      if (limitFilter === "at_limit") {
        const atLimit =
          (r.limits.videosUploaded < 999999 && r.videosUploaded >= r.limits.videosUploaded) ||
          (r.limits.metadataGenerated < 999999 && r.metadataGenerated >= r.limits.metadataGenerated) ||
          (r.limits.veoGenerated < 999999 && r.veoGenerated >= r.limits.veoGenerated) ||
          (r.limits.aiMessagesUsed > 0 && r.aiMessagesUsed >= r.limits.aiMessagesUsed);
        if (!atLimit) return false;
      }
      return true;
    });
  }, [overview, planFilter, limitFilter]);

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

  const freeCount = overview.filter((r) => (r.plan ?? "free") === "free").length;
  const proCount = overview.filter((r) => r.plan === "pro").length;
  const eliteCount = overview.filter((r) => r.plan === "elite").length;
  const atLimitCount = overview.filter(
    (r) =>
      (r.limits.videosUploaded < 999999 && r.videosUploaded >= r.limits.videosUploaded) ||
      (r.limits.metadataGenerated < 999999 && r.metadataGenerated >= r.limits.metadataGenerated) ||
      (r.limits.veoGenerated < 999999 && r.veoGenerated >= r.limits.veoGenerated) ||
      (r.limits.aiMessagesUsed > 0 && r.aiMessagesUsed >= r.limits.aiMessagesUsed)
  ).length;

  const updatePlan = (v: PlanFilter) => { setPlanFilter(v); };
  const updateLimit = (v: LimitFilter) => { setLimitFilter(v); };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Usage: {currentMonth}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {filtered.length} of {overview.length} users shown
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
            <p className="text-sm text-muted-foreground">Elite Users</p>
            <p className="text-2xl font-bold">{eliteCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">At Upload Limit</p>
            <p className="text-2xl font-bold">{atLimitCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Plan filter */}
        <div className="flex items-center gap-1 border rounded-lg p-1">
          {(["all", "free", "pro", "elite"] as PlanFilter[]).map((p) => (
            <button
              key={p}
              onClick={() => updatePlan(p)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md capitalize transition-colors",
                planFilter === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {p}
            </button>
          ))}
        </div>

        {/* At-limit filter */}
        <div className="flex items-center gap-1 border rounded-lg p-1">
          {([["all", "All"], ["at_limit", "At Limit"]] as [LimitFilter, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => updateLimit(val)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                limitFilter === val
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Usage table */}
      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground text-center">
              No usage data matches the current filters.
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
                    <th className="px-4 py-3 font-medium text-muted-foreground">AI Msgs (X/limit)</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => {
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
                              row.plan === "elite" ? "bg-purple-500 text-white hover:bg-purple-600" :
                              row.plan === "pro"   ? "bg-blue-500 text-white hover:bg-blue-600" :
                                                    "bg-muted text-muted-foreground hover:bg-muted"
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
                        <td className="px-4 py-3 font-mono text-xs">
                          {row.aiMessagesUsed} / {formatLimit(row.limits.aiMessagesUsed)}
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
