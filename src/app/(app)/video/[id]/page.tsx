"use client";

import { use } from "react";
import { useQuery, useMutation } from "convex/react";
import { Play, Calendar as CalendarIcon, Youtube } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { VideoStatusBadge } from "@/components/video-status-badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { AIConfigForm } from "@/components/ai-config-form";
import { MetadataEditor } from "@/components/metadata-editor";

export default function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // In Next 15, params is a Promise that must be unwrapped with React.use()
  const unwrappedParams = use(params);
  const videoId = unwrappedParams.id as Id<"videos">;
  
  const video = useQuery(api.videos.get, { id: videoId });
  const updateStatus = useMutation(api.videos.updateStatus);
  const triggerPublish = useMutation(api.jobs.create);

  if (video === undefined) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  const handlePublish = async () => {
    // Instead of useAction which requires more setup, let's just create the job directly
    // since jobs.ts handles the dispatching of the scheduled action.
    await updateStatus({ id: video._id, status: "publishing" });
    await triggerPublish({ videoId: video._id, type: "publish" });
  };

  return (
    <div className="max-w-5xl mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">{video.title}</h1>
            <VideoStatusBadge status={video.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            {(video.rawFileSize / (1024 * 1024)).toFixed(1)} MB • Uploaded {new Date(video._creationTime).toLocaleDateString()}
          </p>
        </div>
        
        <div className="flex gap-2">
          {video.status === "ready" && (
            <>
              <Button variant="outline"><CalendarIcon className="mr-2 h-4 w-4" /> Schedule</Button>
              <Button onClick={handlePublish} className="bg-primary hover:bg-primary/90 text-white">
                <Youtube className="mr-2 h-4 w-4" /> Publish Now
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Video Preview and AI Config */}
        <div className="lg:col-span-1 space-y-6">
          <div className="aspect-video bg-black rounded-lg flex items-center justify-center relative overflow-hidden border">
            {video.thumbnailUrl ? (
              <img src={video.thumbnailUrl} alt="Thumbnail" className="w-full h-full object-cover opacity-80" />
            ) : (
              <Play className="w-12 h-12 text-white/50" />
            )}
            {video.status === "generating" && (
              <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center text-white gap-3">
                <LoadingSpinner />
                <span className="font-medium text-sm animate-pulse">AI Generation in progress...</span>
              </div>
            )}
            {video.status === "publishing" && (
              <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center text-white gap-3">
                <LoadingSpinner />
                <span className="font-medium text-sm animate-pulse">Publishing to YouTube...</span>
              </div>
            )}
          </div>
          
          <AIConfigForm videoId={video._id} />
        </div>

        {/* Right Column: Metadata Editor */}
        <div className="lg:col-span-2">
          <MetadataEditor video={video as any} />
        </div>
      </div>
    </div>
  );
}
