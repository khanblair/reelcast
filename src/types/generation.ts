import type { VeoModelKey } from "@/lib/constants";

export interface GenerationConfig {
  model: VeoModelKey;
  prompt: string;
  negativePrompt?: string;
  resolution: string;
  aspectRatio: string;
  durationSeconds: number;
  generateAudio: boolean;
  enhancePrompt: boolean;
  personGeneration?: string;
  numberOfVideos?: number;
  seed?: number;
}

export interface GenerationDefaults {
  model: VeoModelKey;
  resolution: string;
  aspectRatio: string;
  durationSeconds: number;
  generateAudio: boolean;
  enhancePrompt: boolean;
  personGeneration: string;
  numberOfVideos: number;
}

export interface GenerationRecord {
  _id: string;
  _creationTime: number;
  userId: string;
  videoId: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  resolution: string;
  aspectRatio: string;
  durationSeconds: number;
  generateAudio: boolean;
  status: "submitted" | "processing" | "completed" | "failed";
  veoOperationName?: string;
  outputVideoUrl?: string;
  thumbnailUrl?: string;
  error?: string;
  generationTimeMs?: number;
}
