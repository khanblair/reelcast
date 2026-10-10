"use client";

import { useState, useMemo } from "react";
import { api, useQuery, useAction } from "@/lib/rpc/client";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from "recharts";
import { HardDrive, PlaySquare, Clock, Video, Eye, ThumbsUp, MessageSquare, Timer, RefreshCw, Youtube, Loader2, MousePointerClick } from "lucide-react";
import { formatDateTimeEAT } from "@/lib/eat";

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

export default function AnalyticsPage() {
  const stats          = useQuery(api.analytics.getDashboardStats);
  const channelSummary = useQuery(api.videoAnalytics.getChannelSummary);
  const videoAnalytics = useQuery(api.videoAnalytics.listForUser, {});
  const allVideos      = useQuery(api.videos.list);
  const series         = useQuery(api.videoAnalytics.getTimeSeriesForUser, {});
  const fetchAnalytics = useAction(api.actions.youtubeAnalytics.fetchForUser);
  const [isFetchingAnalytics, setIsFetchingAnalytics] = useState(false);
  const [fetchNote, setFetchNote] = useState<{ text: string; isError: boolean } | null>(null);

  const videoTitleMap = useMemo(
    () => new Map((allVideos ?? []).map((v) => [v._id as string, v.aiTitle ?? v.title] as const)),
    [allVideos]
  );

  const totalLikes = useMemo(
    () => (videoAnalytics ?? []).reduce((s, r) => s + (r.likes ?? 0), 0),
    [videoAnalytics]
  );
  const totalComments = useMemo(
    () => (videoAnalytics ?? []).reduce((s, r) => s + (r.comments ?? 0), 0),
    [videoAnalytics]
  );
  const avgViewDurationSec = useMemo(() => {
    const rows = videoAnalytics ?? [];
    if (rows.length === 0) return 0;
    return rows.reduce((s, r) => s + (r.avgViewDurationSec ?? 0), 0) / rows.length;
  }, [videoAnalytics]);
  const lastFetchedAt = useMemo(() => {
    const times = (videoAnalytics ?? []).map((r) => r.fetchedAt).filter(Boolean);
    return times.length > 0 ? Math.max(...times) : null;
  }, [videoAnalytics]);
  const topVideos = useMemo(
    () => [...(videoAnalytics ?? [])].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 10),
    [videoAnalytics]
  );

  const handleFetchAnalytics = async () => {
    setIsFetchingAnalytics(true);
    setFetchNote(null);
    try {
      const run = await fetchAnalytics();
      if (run.truncated) {
        setFetchNote({ text: `Refreshed the ${run.processed} most recent of ${run.total} published videos.`, isError: false });
      }
    } catch (e) {
      console.error("Analytics fetch failed:", e);
      setFetchNote({ text: e instanceof Error ? e.message : "Analytics refresh failed.", isError: true });
    } finally {
      setIsFetchingAnalytics(false);
    }
  };

  if (stats === undefined || stats === null) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Analytics</h1>
        <p className="text-muted-foreground">Overview of your video generation and storage.</p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Videos</CardTitle>
            <Video className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalVideos}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Storage</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatBytes(stats.totalStorageBytes)}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Duration</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(stats.totalDurationSeconds)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Jobs</CardTitle>
            <PlaySquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats.statusData.find((s: { name: string; count: number }) => s.name === "Generating" || s.name === "Queued" || s.name === "Publishing")?.count || 0}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-7">
        <Card className="lg:col-span-4">
          <CardHeader>
            <CardTitle>Videos Uploaded (Last 7 Days)</CardTitle>
            <CardDescription>Daily breakdown of video activity.</CardDescription>
          </CardHeader>
          <CardContent className="pl-2">
            <div className="h-[200px] sm:h-[300px]">
              <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 200 }}>
                <LineChart data={stats.timelineData} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.1} vertical={false} />
                  <XAxis 
                    dataKey="date" 
                    stroke="#888888" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="#888888" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                    tickFormatter={(value) => `${value}`} 
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--border))' }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="count" 
                    name="Videos"
                    stroke="hsl(var(--primary))" 
                    strokeWidth={2}
                    activeDot={{ r: 6 }} 
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Status Distribution</CardTitle>
            <CardDescription>Current state of your videos.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px] sm:h-[300px]">
              <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 200 }}>
                <BarChart data={stats.statusData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.1} vertical={false} />
                  <XAxis 
                    dataKey="name" 
                    stroke="#888888" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <Tooltip 
                    cursor={{ fill: 'hsl(var(--muted))' }}
                    contentStyle={{ backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--border))' }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                  <Bar dataKey="count" name="Count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* YouTube Analytics */}
      <div className="space-y-6 pt-4 border-t">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">YouTube Analytics</h2>
            {lastFetchedAt && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Last fetched: {formatDateTimeEAT(lastFetchedAt)}
              </p>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleFetchAnalytics}
            disabled={isFetchingAnalytics}
          >
            {isFetchingAnalytics ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Fetching…</>
            ) : (
              <><RefreshCw className="mr-2 h-4 w-4" />Refresh from YouTube</>
            )}
          </Button>
        </div>

        {fetchNote && (
          <p className={`text-sm ${fetchNote.isError ? "text-destructive" : "text-muted-foreground"}`}>{fetchNote.text}</p>
        )}

        {/* Time series: real per-day stats when the daily sync has data, else snapshot totals. */}
        {series && series.source !== "none" && (
          <Card>
            <CardHeader>
              <CardTitle>{series.source === "daily" ? "Views per Day" : "Total Views Over Time"}</CardTitle>
              <CardDescription>
                {series.source === "daily"
                  ? `Last ${series.days} days from YouTube Analytics. The most recent 2-3 days can still be revised.`
                  : "Lifetime views as of each refresh. A per-day breakdown appears after the first daily sync."}
              </CardDescription>
            </CardHeader>
            <CardContent className="pl-2">
              <div className="h-[200px] sm:h-[300px]">
                <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height: 200 }}>
                  <LineChart data={series.points} margin={{ top: 20, right: 30, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.1} vertical={false} />
                    <XAxis
                      dataKey="day"
                      stroke="#888888"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(d: string) => d.slice(5)}
                    />
                    <YAxis stroke="#888888" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'hsl(var(--background))', borderColor: 'hsl(var(--border))' }}
                      itemStyle={{ color: 'hsl(var(--foreground))' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="views"
                      name="Views"
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {videoAnalytics === undefined ? (
          <div className="flex items-center justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : videoAnalytics.length === 0 ? (
          <EmptyState
            icon={Youtube}
            title="No YouTube analytics yet"
            description="Connect YouTube and publish a video, then click Refresh."
          />
        ) : (
          <>
            {/* Channel summary 2×3 grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Views</CardTitle>
                  <Eye className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{(channelSummary?.totalViews ?? 0).toLocaleString()}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Watch Time</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {(() => {
                      const mins = channelSummary?.totalWatchTimeMinutes ?? 0;
                      return mins >= 60 ? `${(mins / 60).toFixed(1)} hrs` : `${mins} mins`;
                    })()}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Likes</CardTitle>
                  <ThumbsUp className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{totalLikes.toLocaleString()}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Total Comments</CardTitle>
                  <MessageSquare className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{totalComments.toLocaleString()}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Avg View Duration</CardTitle>
                  <Timer className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatDuration(avgViewDurationSec)}</div>
                </CardContent>
              </Card>

              {channelSummary?.avgCtr != null && (
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Avg Click-Through Rate</CardTitle>
                    <MousePointerClick className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{(channelSummary.avgCtr * 100).toFixed(1)}%</div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Videos Tracked</CardTitle>
                  <Video className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{videoAnalytics.length}</div>
                </CardContent>
              </Card>
            </div>

            {/* Top videos breakdown */}
            <Card>
              <CardHeader>
                <CardTitle>Top Videos by Views</CardTitle>
                <CardDescription>Up to 10 most-viewed published videos.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground text-xs">
                        <th className="text-left pb-2 pr-4">Video</th>
                        <th className="text-right pb-2 pr-4">Views</th>
                        <th className="text-right pb-2 pr-4">Watch Time</th>
                        <th className="text-right pb-2 pr-4">Likes</th>
                        <th className="text-right pb-2">Comments</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topVideos.map((row) => {
                        const title = videoTitleMap.get(row.videoId) ?? row.youtubeVideoId ?? row.videoId.slice(-8);
                        return (
                          <tr key={row.videoId} className="border-b last:border-0">
                            <td className="py-2 pr-4 max-w-[200px] truncate font-medium" title={title}>{title}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">{(row.views ?? 0).toLocaleString()}</td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {(() => {
                                const mins = row.watchTimeMinutes ?? 0;
                                return mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
                              })()}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">{(row.likes ?? 0).toLocaleString()}</td>
                            <td className="py-2 text-right tabular-nums">{(row.comments ?? 0).toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
