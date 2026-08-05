"use client";

import { useQuery } from "convex/react";
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
import { cn } from "@/lib/utils";

const DAILY_LIMIT = 10_000;

function quotaColor(pct: number) {
  if (pct >= 80) return "bg-red-500";
  if (pct >= 50) return "bg-yellow-500";
  return "bg-green-500";
}

export default function AdminQuotaPage() {
  const overview = useQuery(api.admin.quota.getQuotaOverview);

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

  const totalUsed = overview.reduce((s, r) => s + r.unitsUsed, 0);
  const totalPct = Math.min(100, Math.round((totalUsed / DAILY_LIMIT) * 100));

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">YouTube API Quota Usage — Today</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Daily limit: {DAILY_LIMIT.toLocaleString()} units
        </p>
      </div>

      {/* Total progress card */}
      <Card>
        <CardHeader>
          <CardTitle>Total Used</CardTitle>
          <CardDescription>
            {totalUsed.toLocaleString()} / {DAILY_LIMIT.toLocaleString()} units
            ({totalPct}%)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-4 rounded-full bg-muted overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", quotaColor(totalPct))}
              style={{ width: `${totalPct}%` }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Per-user table */}
      <Card>
        <CardContent className="p-0">
          {overview.length === 0 ? (
            <p className="px-6 py-8 text-sm text-muted-foreground text-center">
              No quota consumed today.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Rank
                    </th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Email
                    </th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Units Used
                    </th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      % of Daily Quota
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.map((row, i) => {
                    const pct = Math.min(
                      100,
                      Math.round((row.unitsUsed / DAILY_LIMIT) * 100),
                    );
                    return (
                      <tr key={row.userId} className="border-b last:border-0">
                        <td className="px-4 py-3 text-muted-foreground">
                          {i + 1}
                        </td>
                        <td className="px-4 py-3">{row.email}</td>
                        <td className="px-4 py-3 font-mono">
                          {row.unitsUsed.toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="h-2 w-32 rounded-full bg-muted overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  quotaColor(pct),
                                )}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span
                              className={cn(
                                "text-xs font-medium",
                                pct >= 80
                                  ? "text-red-500"
                                  : pct >= 50
                                    ? "text-yellow-600"
                                    : "text-green-600",
                              )}
                            >
                              {pct}%
                            </span>
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
