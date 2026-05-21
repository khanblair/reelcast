import { z } from "zod";

export const videoUploadSchema = z.object({
  title: z.string().min(1, "Title is required").max(100, "Title must be under 100 characters"),
  description: z.string().max(5000, "Description must be under 5000 characters").optional(),
  tags: z.array(z.string()).max(50, "Maximum 50 tags").optional(),
});

export const aiConfigSchema = z.object({
  preset: z.enum(["cinematic", "vlog", "tutorial", "shortform", "podcast"]).optional(),
  quality: z.enum(["720p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
  captions: z.boolean().optional(),
  backgroundMusic: z.boolean().optional(),
});

export const scheduleSchema = z.object({
  scheduledAt: z.date().min(new Date(), "Must schedule in the future"),
});

export const settingsSchema = z.object({
  defaultPreset: z.enum(["cinematic", "vlog", "tutorial", "shortform", "podcast"]).optional(),
  defaultQuality: z.enum(["720p", "1080p", "4k"]).optional(),
  defaultCaptions: z.boolean().optional(),
  defaultBackgroundMusic: z.boolean().optional(),
  notifyOnGenerationComplete: z.boolean().optional(),
  notifyOnPublishSuccess: z.boolean().optional(),
  notifyOnPublishFailure: z.boolean().optional(),
});

export type VideoUploadInput = z.infer<typeof videoUploadSchema>;
export type AIConfigInput = z.infer<typeof aiConfigSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
