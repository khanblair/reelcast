"use client";

import { use, useState, useMemo, useEffect } from "react";
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
  Zap,
  AlertTriangle,
  RefreshCw,
  Eye,
  ThumbsUp,
  MessageSquare,
  Clock,
  Image as ImageIcon,
  Captions,
  History,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { Id } from "../../../../../convex/_generated/dataModel";
import { formatDateTimeEAT, formatCountdown } from "@/lib/eat";
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

  const video        = useQuery(api.videos.get, { id: videoId });
  const allVideos    = useQuery(api.videos.list);
  const userSettings = useQuery(api.settings.get);
  const updateStatus = useMutation(api.videos.updateStatus);
  const updatePrivacy = useMutation(api.videos.updatePrivacyStatus);
  const updatePublishAs = useMutation(api.videos.updatePublishAs);
  const triggerPublish = useMutation(api.jobs.create);
  const triggerGeneration = useMutation(api.jobs.create);
  const schedulePublishMutation = useMutation(api.videos.schedulePublish);
  const deleteVideoAction = useAction(api.actions.deleteVideo.deleteVideo);
  const generateMetadata = useAction(api.actions.metadata.generateForUpload);
  const fetchVideoAnalytics = useAction(api.actions.youtubeAnalytics.fetchForVideo);
  const generateThumbnail = useAction(api.actions.generateThumbnail.generate);
  const generateCaptions = useAction(api.actions.generateCaptions.generate);

  // YouTube analytics, only fetched when video is published
  const videoAnalytics = useQuery(
    api.videoAnalytics.getForVideo,
    video?.publishedVideoId ? { videoId } : "skip"
  );

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [countdownMs, setCountdownMs] = useState(0);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleTime, setScheduleTime] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [refreshingAnalytics, setRefreshingAnalytics] = useState(false);
  const [generatingThumbnail, setGeneratingThumbnail] = useState(false);
  const [thumbnailError, setThumbnailError] = useState<string | null>(null);
  const [generatingCaptions, setGeneratingCaptions] = useState(false);
  const [captionsError, setCaptionsError] = useState<string | null>(null);
  const [showMetadataHistory, setShowMetadataHistory] = useState(false);
  const [humanizeMetadata, setHumanizeMetadata] = useState(
    userSettings?.humanizeWriting ?? false
  );

  // Position-based estimated auto-publish time for this video
  const estimatedPublishAt = useMemo(() => {
    if (!userSettings?.autoPublishEnabled || !userSettings.autoPublishNextAt) return undefined;
    if (!video || video.status !== "ready") return undefined;
    const nextAt     = userSettings.autoPublishNextAt;
    const intervalMs = userSettings.autoPublishIntervalMs ?? 6 * 3_600_000;
    const count      = userSettings.autoPublishCount ?? 1;
    const readyVideos = (allVideos ?? [])
      .filter((v) => v.status === "ready")
      .sort((a, b) => a._creationTime - b._creationTime);
    const idx = readyVideos.findIndex((v) => v._id === video._id);
    if (idx === -1) return undefined;
    return nextAt + Math.floor(idx / count) * intervalMs;
  }, [allVideos, userSettings, video]);

  // Live countdown, ticks every second toward the nearest upcoming event
  useEffect(() => {
    const target =
      video?.status === "draft" && video?.metadataScheduledAt && video.metadataScheduledAt > Date.now()
        ? video.metadataScheduledAt
        : estimatedPublishAt;
    if (!target) { setCountdownMs(0); return; }
    const tick = () => setCountdownMs(Math.max(0, target - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [video, estimatedPublishAt]);

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
      await generateMetadata({ videoId: video._id, humanize: humanizeMetadata });
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : "Regeneration failed");
    } finally {
      setRegenerating(false);
    }
  };

  const handleSchedule = async () => {
    if (!scheduleTime) return;
    setScheduling(true);
    setScheduleError(null);
    try {
      await schedulePublishMutation({
        id: video._id,
        scheduledAt: new Date(scheduleTime).getTime(),
        privacyStatus: (video.privacyStatus ?? "public") as "private" | "public" | "unlisted",
      });
      setShowScheduleDialog(false);
      setScheduleTime("");
    } catch (err) {
      setScheduleError(err instanceof Error ? err.message : "Scheduling failed");
    } finally {
      setScheduling(false);
    }
  };

  const handleRefreshAnalytics = async () => {
    setRefreshingAnalytics(true);
    try {
      await fetchVideoAnalytics({ videoId });
    } catch (e) {
      console.error("Analytics refresh failed:", e);
    } finally {
      setRefreshingAnalytics(false);
    }
  };

  const handleGenerateThumbnail = async () => {
    setGeneratingThumbnail(true);
    setThumbnailError(null);
    try {
      await generateThumbnail({ videoId });
    } catch (e) {
      setThumbnailError(e instanceof Error ? e.message : "Thumbnail generation failed");
    } finally {
      setGeneratingThumbnail(false);
    }
  };

  const handleGenerateCaptions = async () => {
    setGeneratingCaptions(true);
    setCaptionsError(null);
    try {
      await generateCaptions({ videoId });
    } catch (e) {
      setCaptionsError(e instanceof Error ? e.message : "Captions generation failed");
    } finally {
      setGeneratingCaptions(false);
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
          <p className="text-muted-foreground text-sm flex flex-wrap items-center gap-1.5">
            {isGenerated
              ? `Created ${new Date(video._creationTime).toLocaleDateString()}`
              : video.rawFileSize > 0
                ? `${(video.rawFileSize / (1024 * 1024)).toFixed(1)} MB \u2022 Uploaded ${new Date(video._creationTime).toLocaleDateString()}`
                : `Created ${new Date(video._creationTime).toLocaleDateString()}`
            }
            {(video as any).duration && (
              <>
                <span className="opacity-40">\u00b7</span>
                <span
                  className={`inline-flex items-center gap-1 font-medium ${
                    (video as any).duration > 60 && (video as any).publishAs !== "video"
                      ? "text-orange-500"
                      : "text-foreground"
                  }`}
                >
                  {(video as any).duration > 60 && (video as any).publishAs !== "video" && (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  )}
                  {Math.floor((video as any).duration / 60)}:{((video as any).duration % 60).toString().padStart(2, "0")}s
                </span>
              </>
            )}
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
                {/* Publish as Short / Video toggle */}
                <div className="flex rounded-md border border-input overflow-hidden text-xs font-medium">
                  <button
                    type="button"
                    onClick={() => updatePublishAs({ id: video._id, publishAs: "short" })}
                    className={`px-3 py-1.5 transition-colors ${
                      (video as any).publishAs !== "video"
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted text-muted-foreground"
                    }`}
                  >
                    Short
                  </button>
                  <button
                    type="button"
                    onClick={() => updatePublishAs({ id: video._id, publishAs: "video" })}
                    className={`px-3 py-1.5 transition-colors ${
                      (video as any).publishAs === "video"
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted text-muted-foreground"
                    }`}
                  >
                    Video
                  </button>
                </div>
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
                <Button variant="outline" onClick={() => setShowScheduleDialog(true)}>
                  <CalendarIcon className="mr-2 h-4 w-4" /> Schedule
                </Button>
                <Button onClick={handlePublish} className="bg-primary hover:bg-primary/90 text-white">
                  <Youtube className="mr-2 h-4 w-4" /> Publish Now
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Uploading as{" "}
                <span className="font-medium text-foreground">
                  {(video as any).publishAs === "video" ? "regular Video" : "Short"}
                </span>
                {" · "}
                {PRIVACY_LABELS[(video.privacyStatus ?? "public") as PrivacyStatus]}
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

      {/* Schedule publish dialog */}
      <Dialog open={showScheduleDialog} onOpenChange={(open) => { setShowScheduleDialog(open); if (!open) { setScheduleTime(""); setScheduleError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarIcon className="h-5 w-5" />
              Schedule Publish
            </DialogTitle>
            <DialogDescription>
              Choose when to publish{" "}
              <span className="font-medium text-foreground">
                &ldquo;{video.aiTitle ?? video.title}&rdquo;
              </span>{" "}
              to YouTube. Time is in your local timezone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <input
              type="datetime-local"
              value={scheduleTime}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              onChange={(e) => setScheduleTime(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            />
          </div>
          {scheduleError && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {scheduleError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setShowScheduleDialog(false); setScheduleTime(""); setScheduleError(null); }}
              disabled={scheduling}
            >
              Cancel
            </Button>
            <Button onClick={handleSchedule} disabled={!scheduleTime || scheduling}>
              {scheduling ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Scheduling…</>
              ) : (
                <><CalendarIcon className="mr-2 h-4 w-4" />Schedule</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Metadata schedule banner, shown for draft videos with a pending AI metadata job */}
      {video.status === "draft" && video.metadataScheduledAt && video.metadataScheduledAt > Date.now() && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <Wand2 className="h-4 w-4 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="font-medium">AI Metadata Scheduled</span>
            <span className="text-amber-600 dark:text-amber-400 ml-2">
              {formatDateTimeEAT(video.metadataScheduledAt)}
            </span>
            {countdownMs > 0 ? (
              <span className="ml-2 text-xs opacity-75">({formatCountdown(countdownMs)})</span>
            ) : null}
          </div>
        </div>
      )}

      {/* Auto-publish banner, shown for ready videos when auto-publish is active */}
      {video.status === "ready" && estimatedPublishAt && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
          <Zap className="h-4 w-4 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="font-medium">Auto-Publish Scheduled</span>
            <span className="ml-2">{formatDateTimeEAT(estimatedPublishAt)}</span>
            {countdownMs > 0 ? (
              <span className="ml-2 text-xs opacity-75">({formatCountdown(countdownMs)})</span>
            ) : null}
          </div>
        </div>
      )}

      {/* Content ID copyright warning, duration >60s published as Short risks copyright block */}
      {(video as any).duration > 60 && (video as any).publishAs !== "video" && (
        <div className="flex items-start gap-3 rounded-lg border border-orange-500/40 bg-orange-500/10 px-4 py-3 text-sm text-orange-700 dark:text-orange-400">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1">
            <p className="font-medium">Possible Content ID block</p>
            <p className="text-xs opacity-90">
              This video is {(video as any).duration}s, over 60s. Publishing as a Short
              may be blocked if the audio is claimed by a rights holder.{" "}
              <strong>Publish as Video</strong> to avoid this (removes #Shorts from the description,
              which usually grants more lenient copyright rules).
            </p>
          </div>
          <button
            type="button"
            onClick={() => updatePublishAs({ id: video._id, publishAs: "video" })}
            className="shrink-0 rounded-md bg-orange-500 hover:bg-orange-600 text-white text-xs font-semibold px-3 py-1.5 transition-colors"
          >
            Switch to Video
          </button>
        </div>
      )}

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
          <div className="flex flex-wrap items-center gap-2">
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
            <button
              type="button"
              onClick={() => setHumanizeMetadata((v) => !v)}
              title={humanizeMetadata ? "Humanize: ON — AI-slop patterns will be stripped" : "Humanize: OFF — click to enable human-style writing"}
              className={[
                "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                humanizeMetadata
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              <Sparkles className="h-3 w-3" />
              Humanize
            </button>
            {video.rawFileKey?.includes("res.cloudinary.com") && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateThumbnail}
                  disabled={generatingThumbnail}
                >
                  {generatingThumbnail ? (
                    <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Generating…</>
                  ) : (
                    <><ImageIcon className="mr-2 h-3.5 w-3.5" />Generate Thumbnail</>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateCaptions}
                  disabled={generatingCaptions}
                >
                  {generatingCaptions ? (
                    <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Generating…</>
                  ) : (
                    <><Captions className="mr-2 h-3.5 w-3.5" />Generate Captions</>
                  )}
                </Button>
              </>
            )}
          </div>
          {regenError && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {regenError}
            </p>
          )}
          {thumbnailError && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {thumbnailError}
            </p>
          )}
          {captionsError && (
            <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {captionsError}
            </p>
          )}
          {(video as any).thumbnailGeneratedUrl && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ImageIcon className="h-4 w-4" />
                  AI-Selected Thumbnail
                </CardTitle>
              </CardHeader>
              <CardContent>
                <img
                  src={(video as any).thumbnailGeneratedUrl}
                  alt="AI-selected thumbnail"
                  className="rounded-md w-full max-w-xs object-cover"
                />
                <p className="text-xs text-muted-foreground mt-2">
                  Best frame selected by AI. Use this URL as your YouTube thumbnail.
                </p>
              </CardContent>
            </Card>
          )}
          {(video as any).captionsVtt && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Captions className="h-4 w-4" />
                  Generated Captions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs bg-muted rounded-md p-3 overflow-x-auto max-h-40 whitespace-pre-wrap font-mono">
                  {(video as any).captionsVtt}
                </pre>
                <p className="text-xs text-muted-foreground mt-2">
                  WebVTT format. Copy and upload as a caption track on YouTube.
                </p>
              </CardContent>
            </Card>
          )}
          <MetadataEditor video={video as VideoType} />
          {(video as any).metadataHistory?.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <button
                  type="button"
                  className="flex items-center justify-between w-full text-left"
                  onClick={() => setShowMetadataHistory((v) => !v)}
                >
                  <CardTitle className="text-sm flex items-center gap-2">
                    <History className="h-4 w-4" />
                    Metadata History
                    <span className="text-xs font-normal text-muted-foreground">
                      ({(video as any).metadataHistory.length} version{(video as any).metadataHistory.length !== 1 ? "s" : ""})
                    </span>
                  </CardTitle>
                  {showMetadataHistory ? (
                    <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
              </CardHeader>
              {showMetadataHistory && (
                <CardContent className="space-y-3 pt-0">
                  {[...(video as any).metadataHistory].reverse().map(
                    (version: { savedAt: number; aiTitle?: string; aiDescription?: string; aiTags?: string[] }, idx: number) => (
                      <div key={version.savedAt} className="rounded-md border p-3 space-y-1.5">
                        <p className="text-xs text-muted-foreground">
                          {new Date(version.savedAt).toLocaleString("en-KE", {
                            timeZone: "Africa/Nairobi",
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                          {idx === 0 && (
                            <span className="ml-2 text-primary font-medium">Latest</span>
                          )}
                        </p>
                        {version.aiTitle && (
                          <p className="text-xs font-medium truncate">{version.aiTitle}</p>
                        )}
                        {version.aiDescription && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {version.aiDescription}
                          </p>
                        )}
                        {version.aiTags && version.aiTags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {version.aiTags.slice(0, 5).map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                              >
                                {tag}
                              </span>
                            ))}
                            {version.aiTags.length > 5 && (
                              <span className="text-xs text-muted-foreground">
                                +{version.aiTags.length - 5} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  )}
                </CardContent>
              )}
            </Card>
          )}

          {/* YouTube Metrics, shown for published videos */}
          {video.status === "published" && video.publishedVideoId && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Youtube className="h-4 w-4 text-red-500" />
                    YouTube Metrics
                  </CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleRefreshAnalytics}
                    disabled={refreshingAnalytics}
                    className="h-7 text-xs"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${refreshingAnalytics ? "animate-spin" : ""}`} />
                    <span className="ml-1">Refresh</span>
                  </Button>
                </div>
                {videoAnalytics && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Last updated: {formatDateTimeEAT((videoAnalytics as any).fetchedAt)}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                {videoAnalytics ? (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex items-center gap-2">
                      <Eye className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <div>
                        <div className="font-semibold">{((videoAnalytics as any).views ?? 0).toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">Views</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <div>
                        <div className="font-semibold">
                          {(() => {
                            const mins = (videoAnalytics as any).watchTimeMinutes ?? 0;
                            return mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
                          })()}
                        </div>
                        <div className="text-xs text-muted-foreground">Watch Time</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <ThumbsUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <div>
                        <div className="font-semibold">{((videoAnalytics as any).likes ?? 0).toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">Likes</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <div>
                        <div className="font-semibold">{((videoAnalytics as any).comments ?? 0).toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">Comments</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No analytics data yet. Click Refresh to fetch from YouTube.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
