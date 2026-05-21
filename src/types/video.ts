import type { VideoStatus } from "@/lib/constants";

export interface Video {
  _id: string;
  _creationTime: number;
  userId: string;
  title: string;
  description?: string;
  tags?: string[];
  status: VideoStatus;
  rawFileKey: string;
  rawFileSize: number;
  processedFileKey?: string;
  thumbnailUrl?: string;
  duration?: number;
  aiTitle?: string;
  aiDescription?: string;
  aiTags?: string[];
  aiConfig?: AIConfig;
  publishedVideoId?: string;
  publishedAt?: number;
  scheduledPublishAt?: number;
  scheduledGenerationAt?: number;
}

export interface AIConfig {
  preset?: string;
  quality?: string;
  aspectRatio?: string;
  captions?: boolean;
  backgroundMusic?: boolean;
}

export interface VideoFormData {
  title: string;
  description?: string;
  tags?: string[];
}

export const STATUS_LABELS: Record<VideoStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  generating: "Generating",
  ready: "Ready",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
};

export const STATUS_COLORS: Record<VideoStatus, string> = {
  draft: "bg-secondary text-secondary-foreground",
  queued: "bg-warning/20 text-warning",
  generating: "bg-primary/20 text-primary",
  ready: "bg-success/20 text-success",
  scheduled: "bg-warning/20 text-warning",
  publishing: "bg-primary/20 text-primary",
  published: "bg-success/20 text-success",
  failed: "bg-destructive/20 text-destructive",
};
