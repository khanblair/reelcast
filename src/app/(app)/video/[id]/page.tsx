"use client";

import { use } from "react";
import { useQuery, useMutation } from "convex/react";
import { Play, Calendar as CalendarIcon, Youtube, ExternalLink } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { VideoStatusBadge } from "@/components/video-status-badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { AIConfigForm } from "@/components/ai-config-form";
import { MetadataEditor } from "@/components/metadata-editor";
import { PRIVACY_STATUS, PRIVACY_LABELS, type PrivacyStatus } from "@/lib/constants";
import type { Video as VideoType } from "@/types/video";

export default function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // In Next 15, params is a Promise that must be unwrapped with React.use()
  const unwrappedParams = use(params);
  const videoId = unwrappedParams.id as Id<"videos">;
  
  const video = useQuery(api.videos.get, { id: videoId });
  const updateStatus = useMutation(api.videos.updateStatus);
  const updatePrivacy = useMutation(api.videos.updatePrivacyStatus);
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

  const youtubeUrl = video.publishedVideoId
    ? `https://youtu.be/${video.publishedVideoId}`
    : null;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight truncate">{video.title}</h1>
            <VideoStatusBadge status={video.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            {(video.rawFileSize / (1024 * 1024)).toFixed(1)} MB • Uploaded {new Date(video._creationTime).toLocaleDateString()}
          </p>
          {youtubeUrl && (
            <a
              href={youtubeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-1"
            >
              <Youtube className="w-4 h-4" /> View on YouTube <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        
        <div className="flex flex-col items-stretch sm:items-end gap-2 w-full sm:w-auto shrink-0">
          {video.status === "ready" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={video.privacyStatus ?? "private"}
                  onChange={(e) => updatePrivacy({ id: video._id, privacyStatus: e.target.value as PrivacyStatus })}
                  className="w-32"
                >
                  {Object.entries(PRIVACY_STATUS).map(([_key, value]) => (
                    <option key={value} value={value}>
                      {PRIVACY_LABELS[value as PrivacyStatus]}
                    </option>
                  ))}
                </Select>
                <Button variant="outline"><CalendarIcon className="mr-2 h-4 w-4" /> Schedule</Button>
                <Button onClick={handlePublish} className="bg-primary hover:bg-primary/90 text-white">
                  <Youtube className="mr-2 h-4 w-4" /> Publish Now
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Will upload as: <span className="font-medium text-foreground">{PRIVACY_LABELS[(video.privacyStatus ?? "private") as PrivacyStatus]}</span>
              </p>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Video Preview and AI Config */}
        <div className="lg:col-span-1 space-y-6">
          <div className="aspect-video bg-black rounded-lg flex items-center justify-center relative overflow-hidden border">
            {video.rawFileKey.startsWith("http") ? (
              <video src={video.rawFileKey} controls className="w-full h-full object-contain" />
            ) : video.thumbnailUrl ? (
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
          
          <AIConfigForm videoId={video._id} status={video.status} />
        </div>

        {/* Right Column: Metadata Editor */}
        <div className="lg:col-span-2">
          <MetadataEditor video={video as VideoType} />
        </div>
      </div>
    </div>
  );
}
