"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { Upload, Film, Zap, Youtube, HardDrive, Sparkles, Wand2, CalendarClock, ArrowRight } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { VideoCard } from "@/components/video-card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import type { Video as VideoType } from "@/types/video";
import { formatDateTimeEAT, formatCountdown } from "@/lib/eat";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";

type Period = "today" | "week" | "month" | "all";

const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week",  label: "Week" },
  { key: "month", label: "Month" },
  { key: "all",   label: "All time" },
];

const STATUS_COLORS: Record<string, string> = {
  Draft:      "hsl(var(--muted-foreground))",
  Ready:      "hsl(var(--primary))",
  Published:  "hsl(var(--success))",
  Failed:     "hsl(var(--destructive))",
  Generating: "hsl(var(--warning))",
  Publishing: "hsl(var(--warning))",
  Queued:     "hsl(var(--muted-foreground))",
  Scheduled:  "hsl(var(--primary))",
};

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function getRangeStart(period: Period): number {
  const now = Date.now();
  const msDay = 86_400_000;
  if (period === "today")  return now - msDay;
  if (period === "week")   return now - 7 * msDay;
  if (period === "month")  return now - 30 * msDay;
  return 0;
}

function buildTimeline(videos: VideoType[], period: Period) {
  const now = Date.now();
  const msDay = 86_400_000;

  if (period === "today") {
    return Array.from({ length: 6 }, (_, i) => {
      const bucketStart = new Date();
      bucketStart.setHours(i * 4, 0, 0, 0);
      const start = bucketStart.getTime();
      const end   = start + 4 * 3_600_000;
      return {
        date:  `${i * 4}:00`,
        count: videos.filter(v => v._creationTime >= start && v._creationTime < end).length,
      };
    });
  }

  if (period === "week") {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now - (6 - i) * msDay);
      d.setHours(0, 0, 0, 0);
      const start = d.getTime();
      return {
        date:  `${d.getMonth() + 1}/${d.getDate()}`,
        count: videos.filter(v => v._creationTime >= start && v._creationTime < start + msDay).length,
      };
    });
  }

  if (period === "month") {
    return Array.from({ length: 4 }, (_, i) => {
      const end   = now - (3 - i) * 7 * msDay;
      const start = end - 7 * msDay;
      const d = new Date(start);
      return {
        date:  `${d.getMonth() + 1}/${d.getDate()}`,
        count: videos.filter(v => v._creationTime >= start && v._creationTime < end).length,
      };
    });
  }

  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - (5 - i), 1);
    d.setHours(0, 0, 0, 0);
    const start = d.getTime();
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    return {
      date:  d.toLocaleString("default", { month: "short" }),
      count: videos.filter(v => v._creationTime >= start && v._creationTime < end).length,
    };
  });
}

export default function DashboardPage() {
  const videos          = useQuery(api.videos.list);
  const jobs            = useQuery(api.jobs.list);
  const userSettings    = useQuery(api.settings.get);
  const scheduledVideos = useQuery(api.videos.listScheduled);
  const [period, setPeriod] = useState<Period>("week");

  // Live countdown to next auto-publish run
  const [autoCountdownMs, setAutoCountdownMs] = useState(0);
  useEffect(() => {
    const target = userSettings?.autoPublishNextAt;
    if (!target) { setAutoCountdownMs(0); return; }
    const tick = () => setAutoCountdownMs(Math.max(0, target - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [userSettings?.autoPublishNextAt]);

  const rangeStart     = getRangeStart(period);
  const filteredVideos = useMemo(
    () => (videos ?? []).filter(v => v._creationTime >= rangeStart),
    [videos, rangeStart]
  );
  const filteredJobs = useMemo(
    () => (jobs ?? []).filter(j => j._creationTime >= rangeStart),
    [jobs, rangeStart]
  );
  const publishedCount = useMemo(
    () => filteredVideos.filter(v => v.status === "published").length,
    [filteredVideos]
  );
  const storageBytes = useMemo(
    () => filteredVideos.reduce((s, v) => s + (v.rawFileSize ?? 0), 0),
    [filteredVideos]
  );
  const timelineData = useMemo(
    () => buildTimeline(videos ?? [], period),
    [videos, period]
  );
  const statusData = useMemo(() => {
    const counts: Record<string, number> = {};
    filteredVideos.forEach(v => { counts[v.status] = (counts[v.status] ?? 0) + 1; });
    return Object.entries(counts).map(([status, count]) => ({
      name:  status.charAt(0).toUpperCase() + status.slice(1),
      count,
    }));
  }, [filteredVideos]);

  // Pipeline counts
  const metadataQueueCount = useMemo(
    () => (videos ?? []).filter(v => v.metadataScheduledAt && v.metadataScheduledAt > Date.now()).length,
    [videos]
  );
  const nextMetadataAt = useMemo(() => {
    const times = (videos ?? [])
      .map(v => v.metadataScheduledAt)
      .filter((t): t is number => !!t && t > Date.now());
    return times.length > 0 ? Math.min(...times) : undefined;
  }, [videos]);
  const readyCount = useMemo(
    () => (videos ?? []).filter(v => v.status === "ready").length,
    [videos]
  );
  const nextScheduledAt = useMemo(() => {
    const times = (scheduledVideos ?? [])
      .filter(v => v.status === "scheduled" && v.scheduledPublishAt)
      .map(v => v.scheduledPublishAt!);
    return times.length > 0 ? Math.min(...times) : undefined;
  }, [scheduledVideos]);

  // Estimated publish times for ready videos
  const estimatedPublishMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!userSettings?.autoPublishEnabled || !userSettings.autoPublishNextAt) return map;
    const nextAt      = userSettings.autoPublishNextAt;
    const intervalMs  = userSettings.autoPublishIntervalMs ?? 6 * 3_600_000;
    const count       = userSettings.autoPublishCount ?? 1;
    const readyVideos = (videos ?? [])
      .filter(v => v.status === "ready")
      .sort((a, b) => a._creationTime - b._creationTime);
    readyVideos.forEach((v, i) => {
      map.set(v._id, nextAt + Math.floor(i / count) * intervalMs);
    });
    return map;
  }, [videos, userSettings]);

  const isAutoActive = userSettings?.autoPublishEnabled === true;

  if (videos === undefined || jobs === undefined) {
    return <div className="flex h-full items-center justify-center"><LoadingSpinner /></div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header + New Upload */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Welcome back</h1>
          <p className="text-muted-foreground">Here&apos;s what&apos;s happening with your videos.</p>
        </div>
        <div className="flex gap-2">
          <Link href={"/generate" as unknown as "/dashboard"}>
            <Button className="bg-primary hover:bg-primary/90 text-white">
              <Sparkles className="mr-2 h-4 w-4" /> Generate Video
            </Button>
          </Link>
          <Link href="/upload">
            <Button variant="outline">
              <Upload className="mr-2 h-4 w-4" /> Upload
            </Button>
          </Link>
        </div>
      </div>

      {/* Period filters */}
      <div className="flex gap-2 flex-wrap">
        {PERIODS.map(p => (
          <Button
            key={p.key}
            size="sm"
            variant={period === p.key ? "default" : "outline"}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Videos</CardTitle>
            <Film className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{filteredVideos.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Published</CardTitle>
            <Youtube className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{publishedCount}</div>
          </CardContent>
        </Card>

        {/* Auto-Publish card — replaces old "Active Jobs" */}
        <Card className={isAutoActive ? "border-primary/30" : ""}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Auto-Publish</CardTitle>
            <Zap className={`h-4 w-4 ${isAutoActive ? "text-primary" : "text-muted-foreground"}`} />
          </CardHeader>
          <CardContent>
            {isAutoActive ? (
              <>
                <div className="text-lg font-bold font-mono tabular-nums leading-tight">
                  {userSettings?.autoPublishNextAt
                    ? formatCountdown(autoCountdownMs)
                    : "—"}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {readyCount} ready · {userSettings?.autoPublishNextAt ? formatDateTimeEAT(userSettings.autoPublishNextAt) : ""}
                </p>
              </>
            ) : (
              <>
                <div className="text-sm font-medium text-muted-foreground">Off</div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="text-xs text-muted-foreground">{readyCount} ready waiting</span>
                  <Link href="/schedule" className="text-xs text-primary hover:underline ml-1 inline-flex items-center gap-0.5">
                    Start <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Storage Used</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(storageBytes)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Pipeline strip */}
      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-3 divide-x">
            {/* Metadata Queue */}
            <div className="px-4 py-4 space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                <Wand2 className="h-3.5 w-3.5" />
                Metadata Queue
              </div>
              <div className="text-2xl font-bold">{metadataQueueCount}</div>
              <div className="text-xs text-muted-foreground">
                {nextMetadataAt
                  ? <>Next: {formatDateTimeEAT(nextMetadataAt)}</>
                  : "No jobs queued"}
              </div>
            </div>

            {/* Arrow + Ready Pool */}
            <div className="px-4 py-4 space-y-1 relative">
              <ArrowRight className="absolute -left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/40 bg-background" />
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                <Film className="h-3.5 w-3.5" />
                Ready Pool
              </div>
              <div className="text-2xl font-bold">{readyCount}</div>
              <div className="text-xs text-muted-foreground">available to publish</div>
            </div>

            {/* Arrow + Next Publish */}
            <div className="px-4 py-4 space-y-1 relative">
              <ArrowRight className="absolute -left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/40 bg-background" />
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                <CalendarClock className="h-3.5 w-3.5" />
                Next Publish
              </div>
              {isAutoActive && userSettings?.autoPublishNextAt ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <Badge className="bg-primary/15 text-primary border-primary/30 text-xs px-1.5 py-0 h-5">Auto</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDateTimeEAT(userSettings.autoPublishNextAt)}
                  </div>
                </>
              ) : nextScheduledAt ? (
                <>
                  <div className="text-sm font-semibold">
                    {(scheduledVideos ?? []).filter(v => v.status === "scheduled").length} scheduled
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDateTimeEAT(nextScheduledAt)}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-sm text-muted-foreground">None scheduled</div>
                  <Link href="/schedule" className="text-xs text-primary hover:underline inline-flex items-center gap-0.5">
                    Set up <ArrowRight className="h-3 w-3" />
                  </Link>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Charts */}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-7">
        <Card className="md:col-span-4">
          <CardHeader>
            <CardTitle>Uploads over time</CardTitle>
            <CardDescription>
              {period === "today"  && "Hourly breakdown for today"}
              {period === "week"   && "Daily breakdown for the last 7 days"}
              {period === "month"  && "Weekly breakdown for the last 30 days"}
              {period === "all"    && "Monthly breakdown across all time"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timelineData} margin={{ top: 4, right: 0, left: -28, bottom: 0 }}>
                  <defs>
                    <linearGradient id="uploadGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.1} vertical={false} />
                  <XAxis dataKey="date" stroke="#888888" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="#888888" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--background))", borderColor: "hsl(var(--border))", fontSize: 12 }}
                    itemStyle={{ color: "hsl(var(--foreground))" }}
                  />
                  <Area
                    type="monotone"
                    dataKey="count"
                    name="Videos"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#uploadGradient)"
                    activeDot={{ r: 5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-3">
          <CardHeader>
            <CardTitle>Status breakdown</CardTitle>
            <CardDescription>Distribution across current states</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] flex items-center gap-2">
              {statusData.length > 0 ? (
                <>
                  <ResponsiveContainer width="55%" height="100%">
                    <PieChart>
                      <Pie
                        data={statusData}
                        cx="50%" cy="50%"
                        innerRadius={52} outerRadius={76}
                        dataKey="count"
                        paddingAngle={3}
                        strokeWidth={0}
                      >
                        {statusData.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={STATUS_COLORS[entry.name] ?? `hsl(${index * 55}, 60%, 50%)`}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--background))", borderColor: "hsl(var(--border))", fontSize: 12 }}
                        itemStyle={{ color: "hsl(var(--foreground))" }}
                      />
                    </PieChart>
                  </ResponsiveContainer>

                  <div className="flex flex-col gap-2 text-xs flex-1">
                    {statusData.map((entry, index) => (
                      <div key={entry.name} className="flex items-center gap-2">
                        <div
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: STATUS_COLORS[entry.name] ?? `hsl(${index * 55}, 60%, 50%)` }}
                        />
                        <span className="text-muted-foreground capitalize">{entry.name}</span>
                        <span className="ml-auto font-semibold">{entry.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground mx-auto">No data for this period</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent videos */}
      <h2 className="text-xl font-semibold tracking-tight">Recent Videos</h2>

      {filteredVideos.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {filteredVideos.slice(0, 8).map((video) => (
            <VideoCard
              key={video._id}
              video={video as VideoType}
              estimatedPublishAt={estimatedPublishMap.get(video._id)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Film}
          title="No videos in this period"
          description="Try a wider time range or upload new footage."
        />
      )}
    </div>
  );
}
