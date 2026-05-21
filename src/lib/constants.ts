export const APP_NAME = "ReelCast";

export const VIDEO_STATUS = {
  DRAFT: "draft",
  QUEUED: "queued",
  GENERATING: "generating",
  READY: "ready",
  SCHEDULED: "scheduled",
  PUBLISHING: "publishing",
  PUBLISHED: "published",
  FAILED: "failed",
} as const;

export type VideoStatus = (typeof VIDEO_STATUS)[keyof typeof VIDEO_STATUS];

export const JOB_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export const JOB_TYPE = {
  GENERATION: "generation",
  PUBLISH: "publish",
} as const;

export type JobType = (typeof JOB_TYPE)[keyof typeof JOB_TYPE];

export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB

export const SUPPORTED_VIDEO_FORMATS = [
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
  "video/webm",
];

export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];

export const AI_PRESETS = [
  { value: "cinematic", label: "Cinematic" },
  { value: "vlog", label: "Vlog" },
  { value: "tutorial", label: "Tutorial" },
  { value: "shortform", label: "Short Form" },
  { value: "podcast", label: "Podcast" },
] as const;

export const OUTPUT_QUALITY = [
  { value: "720p", label: "720p HD" },
  { value: "1080p", label: "1080p Full HD" },
  { value: "4k", label: "4K Ultra HD" },
] as const;

export const ASPECT_RATIOS = [
  { value: "16:9", label: "16:9 Landscape" },
  { value: "9:16", label: "9:16 Portrait" },
  { value: "1:1", label: "1:1 Square" },
] as const;

export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard" },
  { href: "/upload", label: "Upload", icon: "Upload" },
  { href: "/drafts", label: "Drafts", icon: "Film" },
  { href: "/schedule", label: "Schedule", icon: "Calendar" },
  { href: "/history", label: "History", icon: "Clock" },
  { href: "/analytics", label: "Analytics", icon: "BarChart3" },
] as const;
