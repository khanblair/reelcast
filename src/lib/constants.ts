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

export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

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

export const AI_TONES = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual & Friendly" },
  { value: "educational", label: "Educational" },
  { value: "entertainment", label: "Entertainment" },
  { value: "technical", label: "Technical" },
] as const;

export const AI_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
] as const;

export const AI_DESCRIPTION_LENGTHS = [
  { value: "short", label: "Short (~100 words)" },
  { value: "medium", label: "Medium (~250 words)" },
  { value: "long", label: "Long (~500 words)" },
] as const;

export const PRIVACY_STATUS = {
  PRIVATE: "private",
  PUBLIC: "public",
  UNLISTED: "unlisted",
} as const;

export type PrivacyStatus = (typeof PRIVACY_STATUS)[keyof typeof PRIVACY_STATUS];

export const PRIVACY_LABELS: Record<PrivacyStatus, string> = {
  private: "Private",
  public: "Public",
  unlisted: "Unlisted",
};

export const VEO_MODELS = [
  {
    value: "veo-3.1-preview",
    label: "Veo 3.1 Preview",
    modelId: "veo-3.1-generate-preview",
    description: "Latest Veo 3.1 — highest quality video via Gemini Developer API.",
    recommended: true,
    maxDuration: 8,
    supportsAudio: true,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
  },
  {
    value: "veo-3",
    label: "Veo 3",
    modelId: "veo-3.0-generate-001",
    description: "Veo 3 stable release. Great quality and broad availability.",
    recommended: false,
    maxDuration: 8,
    supportsAudio: true,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
  },
  {
    value: "veo-3.1-fast-preview",
    label: "Veo 3.1 Fast Preview",
    modelId: "veo-3.1-fast-generate-preview",
    description: "Faster Veo 3.1 generation. Good balance of speed and quality.",
    recommended: false,
    maxDuration: 8,
    supportsAudio: true,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
  },
  {
    value: "veo-3-fast",
    label: "Veo 3 Fast",
    modelId: "veo-3.0-fast-generate-001",
    description: "Fast Veo 3 generation. Reliable on paid API tiers.",
    recommended: false,
    maxDuration: 8,
    supportsAudio: true,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
  },
  {
    value: "veo-3.1-lite",
    label: "Veo 3.1 Lite Preview",
    modelId: "veo-3.1-lite-generate-preview",
    description: "Lightweight and fast. Best for drafts and high-volume generation.",
    recommended: false,
    maxDuration: 8,
    supportsAudio: false,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
  },
  {
    value: "veo-2",
    label: "Veo 2",
    modelId: "veo-2.0-generate-001",
    description: "Stable and reliable. No audio — use Veo 3 for videos with sound.",
    recommended: false,
    maxDuration: 8,
    supportsAudio: false,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
  },
] as const;

export type VeoModelKey = (typeof VEO_MODELS)[number]["value"];

export const VEO_RESOLUTIONS = [
  { value: "720p", label: "720p HD", description: "Fast & efficient", default: true },
  { value: "1080p", label: "1080p Full HD", description: "Higher quality", default: false },
] as const;

export const VEO_ASPECT_RATIOS = [
  { value: "16:9", label: "16:9 Landscape", default: true },
  { value: "9:16", label: "9:16 Portrait", default: false },
  { value: "1:1", label: "1:1 Square", default: false },
] as const;

// Vertex AI supports only 4s, 6s, 8s for text-to-video
export const VEO_DURATIONS = [
  { value: 4, label: "4s" },
  { value: 6, label: "6s" },
  { value: 8, label: "8s" },
] as const;

export const PROMPT_PRESETS = [
  { value: "cinematic", label: "Cinematic Landscape", prompt: "A sweeping cinematic aerial shot of a vast landscape at golden hour, with dramatic clouds and warm sunlight casting long shadows across rolling hills." },
  { value: "product", label: "Product Showcase", prompt: "A sleek product rotating slowly on a clean white surface with soft studio lighting, gentle reflections, and a premium feel." },
  { value: "tutorial", label: "Tutorial Intro", prompt: "An engaging animated intro sequence with modern geometric shapes, bold colors, and smooth transitions that sets a professional tone." },
  { value: "social", label: "Social Media Clip", prompt: "A short, dynamic social media clip with fast cuts, vibrant colors, and trendy motion graphics that grabs attention in the first second." },
  { value: "abstract", label: "Abstract Motion", prompt: "Abstract fluid motion with vibrant iridescent colors flowing and morphing in slow motion against a dark background." },
] as const;

export const VEO_DEFAULTS = {
  model: "veo-3.1-preview" as VeoModelKey,
  resolution: "720p",
  aspectRatio: "16:9",
  durationSeconds: 8,
  enhancePrompt: true,
  generateAudio: true,  // active when Vertex AI creds are present
  numberOfVideos: 1,
} as const;

export const SOURCE_TYPES = {
  UPLOAD: "upload",
  GENERATE: "generate",
} as const;

export type SourceType = (typeof SOURCE_TYPES)[keyof typeof SOURCE_TYPES];

export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard" },
  { href: "/generate", label: "Generate", icon: "Sparkles" },
  { href: "/upload", label: "Upload", icon: "Upload" },
  { href: "/drafts", label: "Drafts", icon: "Film" },
  { href: "/schedule", label: "Schedule", icon: "Calendar" },
  { href: "/history", label: "History", icon: "Clock" },
  { href: "/analytics", label: "Analytics", icon: "BarChart3" },
] as const;
