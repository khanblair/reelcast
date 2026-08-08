"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";

type PlanFilter = "all" | "free" | "pro" | "elite";
type YouTubeFilter = "all" | "connected" | "not_connected";

const PAGE_SIZE = 20;

export default function AdminUsersPage() {
  const users = useQuery(api.admin.users.listAll, {});

  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<PlanFilter>("all");
  const [ytFilter, setYtFilter] = useState<YouTubeFilter>("all");
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = search.toLowerCase().trim();
    return users.filter((u) => {
      if (q && !u.name?.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
      if (planFilter !== "all" && (u.plan ?? "free") !== planFilter) return false;
      if (ytFilter === "connected" && !u.youtubeConnected) return false;
      if (ytFilter === "not_connected" && u.youtubeConnected) return false;
      return true;
    });
  }, [users, search, planFilter, ytFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset to page 1 when filters change
  const updateSearch = (v: string) => { setSearch(v); setPage(1); };
  const updatePlan = (v: PlanFilter) => { setPlanFilter(v); setPage(1); };
  const updateYt = (v: YouTubeFilter) => { setYtFilter(v); setPage(1); };

  if (users === undefined) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {filtered.length} of {users.length} accounts
        </p>
      </div>

      {/* Search + filters row */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search name or email..."
            value={search}
            onChange={(e) => updateSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

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

        {/* YouTube filter */}
        <div className="flex items-center gap-1 border rounded-lg p-1">
          {([["all", "All YT"], ["connected", "Connected"], ["not_connected", "No YT"]] as [YouTubeFilter, string][]).map(([val, label]) => (
            <button
              key={val}
              onClick={() => updateYt(val)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                ytFilter === val
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">Name / Email</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Plan</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">YouTube</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Auto-publish</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Resend Key</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((user) => (
                  <tr key={user._id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div>
                          <p className="font-medium truncate max-w-[180px]">{user.name ?? "—"}</p>
                          <p className="text-muted-foreground text-xs truncate max-w-[180px]">{user.email}</p>
                        </div>
                        {user.isAdmin && <Badge variant="outline" className="text-xs">Admin</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={cn(
                        "text-xs",
                        user.plan === "elite" ? "bg-purple-500 text-white hover:bg-purple-600" :
                        user.plan === "pro"   ? "bg-blue-500 text-white hover:bg-blue-600" :
                                                "bg-muted text-muted-foreground hover:bg-muted"
                      )}>
                        {user.plan ?? "free"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-block h-2.5 w-2.5 rounded-full", user.youtubeConnected ? "bg-green-500" : "bg-red-400")} title={user.youtubeConnected ? "Connected" : "Not connected"} />
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={cn("text-xs", user.autoPublishEnabled ? "border-green-500 text-green-600" : "border-muted-foreground text-muted-foreground")}>
                        {user.autoPublishEnabled ? "On" : "Off"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{user.hasResendApiKey ? "Set" : "—"}</td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/users/${user._id}` as Route}>
                        <Button size="sm" variant="outline">View</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
                {paginated.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No users match the current filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-xs text-muted-foreground">
                Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => p - 1)} disabled={page === 1}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs px-2">{page} / {totalPages}</span>
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setPage((p) => p + 1)} disabled={page === totalPages}>
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
