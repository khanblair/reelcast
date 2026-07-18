"use client";

import { use, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { useRouter } from "next/navigation";
import {
  Play,
  Calendar as CalendarIcon,
  Youtube,
  ExternalLink,
  Sparkles,
  Upload,
  RotateCcw,
  Loader2,
  Trash2,
  Wand2,
} from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import Image from "next/image";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { VideoStatusBadge } from "@/components/video-status-badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { GenerationProgress } from "@/components/generation/generation-progress";
import { MetadataEditor } from "@/components/metadata-editor";
import { PRIVACY_STATUS, PRIVACY_LABELS, type PrivacyStatus } from "@/lib/constants";
import type { Video as VideoType } from "@/types/video";

export default function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const unwrappedParams = use(params);
  const videoId = unwrappedParams.id as Id<"videos">;
  const router = useRouter();

  const video = useQuery(api.videos.get, { id: videoId });
  const updateStatus = useMutation(api.videos.updateStatus);
  const updatePrivacy = useMutation(api.videos.updatePrivacyStatus);
  const triggerPublish = useMutation(api.jobs.create);
  const triggerGeneration = useMutation(api.jobs.create);
  const deleteVideoAction = useAction(api.actions.deleteVideo.deleteVideo);
  const generateMetadata = useAction(api.actions.metadata.generateForUpload);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteVideoAction({ videoId });
      router.push("/drafts");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete video");
      setDeleting(false);
    }
  };

  if (video === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (video === null) {
    return (
      <div className="flex h-[80vh] flex-col items-center justify-center gap-4 text-center">
        <p className="text-lg font-semibold">Video not found</p>
        <p className="text-sm text-muted-foreground">It may have been deleted or you don&apos;t have access.</p>
        <Button variant="outline" onClick={() => router.push("/drafts")}>
          Back to Library
        </Button>
      </div>
    );
  }

  const isGenerated = video.sourceType === "generate";
  const isUploaded = video.sourceType === "upload" || (!video.sourceType && video.rawFileKey?.startsWith("http"));

  const handlePublish = async () => {
    await updateStatus({ id: video._id, status: "publishing" });
    await triggerPublish({ videoId: video._id, type: "publish" });
  };

  const handleGenerate = async () => {
    await updateStatus({ id: video._id, status: "queued" });
    await triggerGeneration({ videoId: video._id, type: "generation" });
  };

  const handleRegenerateMetadata = async () => {
    setRegenerating(true);
    setRegenError(null);
    try {
      await generateMetadata({ videoId: video._id });
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : "Regeneration failed");
    } finally {
      setRegenerating(false);
    }
  };

  const youtubeUrl = video.publishedVideoId
    ? `https://youtu.be/${video.publishedVideoId}`
    : null;

  const videoSrc = video.status === "ready" || video.status === "published"
    ? video.processedFileKey ?? video.rawFileKey
    : video.rawFileKey;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight truncate">
              {video.aiTitle ?? video.title}
            </h1>
            <VideoStatusBadge status={video.status} />
            {isGenerated && (
              <Badge variant="secondary" className="text-xs">
                <Sparkles className="w-3 h-3 mr-1" />
                AI Generated
              </Badge>
            )}
            {isUploaded && (
              <Badge variant="outline" className="text-xs">
                <Upload className="w-3 h-3 mr-1" />
                Uploaded
              </Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            {isGenerated
              ? `Created ${new Date(video._creationTime).toLocaleDateString()}`
              : video.rawFileSize > 0
                ? `${(video.rawFileSize / (1024 * 1024)).toFixed(1)} MB \u2022 Uploaded ${new Date(video._creationTime).toLocaleDateString()}`
                : `Created ${new Date(video._creationTime).toLocaleDateString()}`
            }
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
          {(video as any).cloudinaryDeletedAt && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Storage freed · Cloudinary files deleted after publish
            </p>
          )}
        </div>

        <div className="flex flex-col items-stretch sm:items-end gap-2 w-full sm:w-auto shrink-0">
          {video.status === "ready" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={video.privacyStatus ?? "public"}
                  onChange={(e) =>
                    updatePrivacy({
                      id: video._id,
                      privacyStatus: e.target.value as PrivacyStatus,
                    })
                  }
                  className="w-32"
                >
                  {Object.entries(PRIVACY_STATUS).map(([, value]) => (
                    <option key={value} value={value}>
                      {PRIVACY_LABELS[value as PrivacyStatus]}
                    </option>
                  ))}
                </Select>
                <Button variant="outline">
                  <CalendarIcon className="mr-2 h-4 w-4" /> Schedule
                </Button>
                <Button onClick={handlePublish} className="bg-primary hover:bg-primary/90 text-white">
                  <Youtube className="mr-2 h-4 w-4" /> Publish Now
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Will upload as:{" "}
                <span className="font-medium text-foreground">
                  {PRIVACY_LABELS[(video.privacyStatus ?? "public") as PrivacyStatus]}
                </span>
              </p>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowDeleteDialog(true)}
            className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive mt-1"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Delete Video
          </Button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              Delete Video
            </DialogTitle>
            <DialogDescription>
              This will permanently delete{" "}
              <span className="font-medium text-foreground">
                &ldquo;{video.aiTitle ?? video.title}&rdquo;
              </span>{" "}
              and remove its files from storage. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setShowDeleteDialog(false); setDeleteError(null); }}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Permanently
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="aspect-[9/16] max-h-[70vh] bg-black rounded-lg flex items-center justify-center relative overflow-hidden border mx-auto w-full">
            {videoSrc?.startsWith("http") ? (
              <video src={videoSrc} controls className="w-full h-full object-contain" />
            ) : video.thumbnailUrl ? (
              <Image
                src={video.thumbnailUrl}
                alt="Thumbnail"
                fill
                className="object-cover opacity-80"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-white/40">
                <Play className="w-12 h-12" />
                <span className="text-xs">
                  {isGenerated ? "Video will appear here" : "No preview available"}
                </span>
              </div>
            )}
            {(video.status === "generating" || video.status === "queued") && (
              <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center text-white gap-3">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="font-medium text-sm animate-pulse">
                  {isGenerated ? "Veo is generating your video..." : "AI Generation in progress..."}
                </span>
              </div>
            )}
            {video.status === "publishing" && (
              <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center text-white gap-3">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="font-medium text-sm animate-pulse">Publishing to YouTube...</span>
              </div>
            )}
          </div>

          {isGenerated && video.aiConfig && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Generation Config
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-xs">
                  {video.aiConfig.prompt && (
                    <div>
                      <span className="text-muted-foreground">Prompt:</span>
                      <p className="mt-0.5 line-clamp-3">{video.aiConfig.prompt}</p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {video.aiConfig.model && (
                      <div>
                        <span className="text-muted-foreground">Model:</span>{" "}
                        <span className="font-medium">
                          {video.aiConfig.model === "veo-3.1-fast" ? "Veo 3.1 Fast" : "Veo 3 Fast"}
                        </span>
                      </div>
                    )}
                    {video.aiConfig.resolution && (
                      <div>
                        <span className="text-muted-foreground">Resolution:</span>{" "}
                        <span className="font-medium">{video.aiConfig.resolution}</span>
                      </div>
                    )}
                    {video.aiConfig.aspectRatio && (
                      <div>
                        <span className="text-muted-foreground">Aspect Ratio:</span>{" "}
                        <span className="font-medium">{video.aiConfig.aspectRatio}</span>
                      </div>
                    )}
                    {video.aiConfig.durationSeconds && (
                      <div>
                        <span className="text-muted-foreground">Duration:</span>{" "}
                        <span className="font-medium">{video.aiConfig.durationSeconds}s</span>
                      </div>
                    )}
                  </div>
                </div>

                {(video.status === "draft" || video.status === "failed") && (
                  <div className="mt-4 space-y-2">
                    <Button
                      onClick={handleGenerate}
                      variant={video.status === "failed" ? "destructive" : "default"}
                      className="w-full"
                      size="sm"
                    >
                      <RotateCcw className="mr-2 h-3 w-3" />
                      {video.status === "failed" ? "Retry Generation" : "Generate Video"}
                    </Button>
                    <Button variant="outline" className="w-full" size="sm" onClick={() => { window.location.href = "/generate"; }}>
                      <Sparkles className="mr-2 h-3 w-3" />
                      New Generation
                    </Button>
                  </div>
                )}

                {(video.status === "queued" || video.status === "generating") && (
                  <div className="mt-4">
                    <GenerationProgress status={video.status} />
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {!isGenerated && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Source</CardTitle>
              </CardHeader>
              <CardContent>
                {video.rawFileKey?.startsWith("http") ? (
                  <p className="text-xs text-muted-foreground">
                    Uploaded video file
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">No file uploaded</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-3 space-y-3">
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegenerateMetadata}
              disabled={regenerating}
            >
              {regenerating ? (
                <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Regenerating…</>
              ) : (
                <><Wand2 className="mr-2 h-3.5 w-3.5" />Regenerate Metadata</>
              )}
            </Button>
          </div>
          {regenError && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {regenError}
            </p>
          )}
          <MetadataEditor video={video as VideoType} />
        </div>
      </div>
    </div>
  );
}
