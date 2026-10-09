/** Shared zod pieces for the content modules (videos, jobs, queue, ideas, ...). */
import { z } from "zod";
import { IDEA_STATUSES, JOB_TYPES, PRIVACY_STATUSES, PUBLISH_AS } from "@/db/schema";
import { isAllowedMediaUrl } from "@/server/lib/cloudinary";

export const uuidSchema = z.string().uuid();
export const privacyStatusSchema = z.enum(PRIVACY_STATUSES);
export const publishAsSchema = z.enum(PUBLISH_AS);
export const jobTypeSchema = z.enum(JOB_TYPES);
export const ideaStatusSchema = z.enum(IDEA_STATUSES);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

/** Fields the generate form sends when it creates an AI-generated video. */
const generationConfigFields = {
  model: z.string().max(100).optional(),
  prompt: z.string().max(10_000).optional(),
  negativePrompt: z.string().max(5_000).optional(),
  resolution: z.string().max(20).optional(),
  aspectRatio: z.string().max(20).optional(),
  durationSeconds: z.number().positive().max(3_600).optional(),
  fps: z.number().positive().max(240).optional(),
  generateAudio: z.boolean().optional(),
  enhancePrompt: z.boolean().optional(),
  numberOfVideos: z.number().int().min(1).max(10).optional(),
  personGeneration: z.string().max(50).optional(),
  seed: z.number().int().optional(),
};

export const generationConfigSchema = z.object(generationConfigFields);

/** Full per-video AI config (adds the upload-side presets). */
export const aiConfigSchema = generationConfigSchema.extend({
  preset: z.string().max(50).optional(),
  quality: z.string().max(20).optional(),
  captions: z.boolean().optional(),
  backgroundMusic: z.boolean().optional(),
});

export const tagsSchema = z.array(z.string().max(200)).max(50);

/**
 * Uploaded files live on our Cloudinary account, and the publisher later fetches `rawFileKey`
 * server-side. `isAllowedMediaUrl` (https + res.cloudinary.com + our cloud name) is the single rule
 * shared with the publish/health/destroy code, so a key accepted here can always be published and
 * a client can't point the server at an internal URL (SSRF).
 */
export const isCloudinaryUrl = (value: string): boolean => isAllowedMediaUrl(value);
