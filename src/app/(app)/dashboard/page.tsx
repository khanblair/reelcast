"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { Upload, Plus, Film, Clock } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { VideoCard } from "@/components/video-card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import type { Video as VideoType } from "@/types/video";

export default function DashboardPage() {
  const videos = useQuery(api.videos.list);
  const jobs = useQuery(api.jobs.list);

  if (videos === undefined || jobs === undefined) {
    return <div className="flex h-full items-center justify-center"><LoadingSpinner /></div>;
  }

  const recentDrafts = videos.filter(v => v.status === "draft").slice(0, 4);
  const activeJobs = jobs.filter(j => j.status === "pending" || j.status === "processing");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Welcome back</h1>
        <p className="text-muted-foreground">Here&apos;s what&apos;s happening with your videos today.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Videos</CardTitle>
            <Film className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{videos.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Jobs</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeJobs.length}</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Recent Drafts</h2>
        <Link href="/upload">
          <Button className="w-full sm:w-auto">
            <Upload className="mr-2 h-4 w-4" /> New Upload
          </Button>
        </Link>
      </div>

      {recentDrafts.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {recentDrafts.map((video) => (
            <VideoCard key={video._id} video={video as VideoType} />
          ))}
        </div>
      ) : (
        <EmptyState 
          icon={Film}
          title="No recent drafts"
          description="Upload some raw footage to get started."
          action={
            <Link href="/upload">
              <Button variant="outline" className="mt-4">
                <Plus className="mr-2 h-4 w-4" /> Upload Video
              </Button>
            </Link>
          }
        />
      )}
    </div>
  );
}
