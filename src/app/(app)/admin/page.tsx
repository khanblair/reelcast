"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import {
  Users,
  Youtube,
  Video,
  CheckCircle,
  Activity,
  Zap,
  HardDrive,
  TrendingUp,
  ArrowRight,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { formatDateTimeEAT } from "@/lib/eat";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}

function StatCard({ icon, label, value }: StatCardProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className="text-muted-foreground">{icon}</div>
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const ACTION_CARDS = [
  {
    href: "/admin/users",
    title: "Manage Users",
    description: "View plans, YouTube connections, and admin roles.",
  },
  {
    href: "/admin/quota",
    title: "YouTube Quota",
    description: "Monitor daily API quota usage across all users.",
  },
  {
    href: "/admin/storage",
    title: "Storage",
    description: "Total storage consumed across all uploaded videos.",
  },
];

export default function AdminOverviewPage() {
  const stats = useQuery(api.admin.stats.getStats);
  const failedJobs = useQuery(api.admin.jobs.listFailed, { limit: 10 });
  const broadcastToAll = useMutation(api.admin.notifications.broadcastToAll);

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [type, setType] = useState<"info" | "success" | "warning" | "error">("info");
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  if (stats === undefined) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  const successLabel =
    stats.successRate24h === null
      ? "N/A"
      : `${Math.round(stats.successRate24h * 100)}%`;

  async function handleBroadcast() {
    if (!title.trim() || !message.trim()) return;
    setIsSending(true);
    setBroadcastResult(null);
    try {
      const result = await broadcastToAll({ title: title.trim(), message: message.trim(), type });
      setBroadcastResult(`Sent to ${(result as { count?: number })?.count ?? "all"} users`);
      setTitle("");
      setMessage("");
    } catch {
      setBroadcastResult("Failed to send notification.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Admin Overview</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Platform-wide metrics at a glance.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label="Total Users"
          value={stats.totalUsers}
        />
        <StatCard
          icon={<Youtube className="h-5 w-5" />}
          label="YouTube Connected"
          value={stats.youtubeConnected}
        />
        <StatCard
          icon={<Video className="h-5 w-5" />}
          label="Total Videos"
          value={stats.totalVideos}
        />
        <StatCard
          icon={<CheckCircle className="h-5 w-5" />}
          label="Published Videos"
          value={stats.publishedVideos}
        />
        <StatCard
          icon={<Activity className="h-5 w-5" />}
          label="Jobs Today"
          value={stats.jobsToday}
        />
        <StatCard
          icon={<Zap className="h-5 w-5" />}
          label="Auto-publish Active"
          value={stats.autoPublishActive}
        />
        <StatCard
          icon={<HardDrive className="h-5 w-5" />}
          label="Total Storage"
          value={formatBytes(stats.totalStorageBytes)}
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="Success Rate 24h"
          value={successLabel}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {ACTION_CARDS.map((card) => (
          <Link key={card.href} href={card.href as Route}>
            <Card className="h-full hover:bg-muted/50 transition-colors cursor-pointer">
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  {card.title}
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </CardTitle>
                <CardDescription>{card.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      {/* Recent Failures */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Recent Failures</h2>
        <Card>
          <CardContent className="p-0">
            {failedJobs === undefined ? (
              <div className="flex justify-center py-8">
                <LoadingSpinner />
              </div>
            ) : failedJobs.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-6">
                No failures in the current period.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="px-4 py-3 font-medium text-muted-foreground">Type</th>
                      <th className="px-4 py-3 font-medium text-muted-foreground">Video</th>
                      <th className="px-4 py-3 font-medium text-muted-foreground">User</th>
                      <th className="px-4 py-3 font-medium text-muted-foreground">Error</th>
                      <th className="px-4 py-3 font-medium text-muted-foreground">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failedJobs.map((job) => (
                      <tr key={job._id} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <Badge
                            className={
                              job.type === "publish"
                                ? "bg-blue-500 text-white hover:bg-blue-600 text-xs"
                                : "bg-purple-500 text-white hover:bg-purple-600 text-xs"
                            }
                          >
                            {job.type}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 truncate max-w-[160px]">
                          {job.videoTitle ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground truncate max-w-[160px]">
                          {job.userEmail ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-red-500 truncate max-w-[240px]">
                          {job.error ? job.error.slice(0, 60) : "—"}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {job.startedAt ? formatDateTimeEAT(job.startedAt) : "—"}
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

      {/* Broadcast Notification */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Broadcast Notification</h2>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Send to All Users</CardTitle>
            <CardDescription>
              Push an in-app notification to every user on the platform.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Notification title"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Message</label>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Notification message"
                rows={3}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Type</label>
              <Select
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
                className="w-40"
              >
                <option value="info">Info</option>
                <option value="success">Success</option>
                <option value="warning">Warning</option>
                <option value="error">Error</option>
              </Select>
            </div>
            <div className="flex items-center gap-4">
              <Button
                onClick={handleBroadcast}
                disabled={isSending || !title.trim() || !message.trim()}
              >
                {isSending ? "Sending..." : "Send to All Users"}
              </Button>
              {broadcastResult && (
                <p className="text-sm text-muted-foreground">{broadcastResult}</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
