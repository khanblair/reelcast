"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { Film, Plus } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { VideoCard } from "@/components/video-card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import type { Video as VideoType } from "@/types/video";

export default function DraftsPage() {
  const videos = useQuery(api.videos.list);

  if (videos === undefined) {
    return <div className="flex h-full items-center justify-center"><LoadingSpinner /></div>;
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Video Library</h1>
          <p className="text-muted-foreground">Manage your uploads, drafts, and published content.</p>
        </div>
        <Link href="/upload">
          <Button>
            <Plus className="mr-2 h-4 w-4" /> New Upload
          </Button>
        </Link>
      </div>

      {videos.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {videos.map((video) => (
            <VideoCard key={video._id} video={video as VideoType} />
          ))}
        </div>
      ) : (
        <EmptyState 
          icon={Film}
          title="Your library is empty"
          description="Upload your first piece of raw footage to get started."
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
