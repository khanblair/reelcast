/**
 * settings.update: an explicit allow-list (no mass assignment) and the rules for each field.
 *
 *   undefined          -> leave the column alone
 *   null / "" / [] ... -> clear an optional column
 *   BYOK keys          -> trimmed, encrypted at rest (never read back; the DTO exposes has*ApiKey)
 */
import { z } from "zod";
import { encryptSecret } from "@/server/crypto";
import { badRequest } from "@/server/rpc/errors";
import { PRIVACY_STATUSES, type settings } from "@/db/schema";

type SettingsInsert = typeof settings.$inferInsert;

const str = (max: number) => z.string().max(max).nullable().optional();
const bool = z.boolean().nullable().optional();
const int = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();

export const settingsUpdateInput = z
  .object({
    aiPreset: str(100),
    defaultQuality: str(100),
    defaultAspectRatio: str(100),
    defaultCaptions: bool,
    defaultBackgroundMusic: bool,
    // NOT NULL column: a boolean or nothing.
    notificationsEnabled: z.boolean().optional(),
    telegramChatId: str(200),
    discordWebhookUrl: str(500),
    aiAutoGenerate: bool,
    aiGenerateTitle: bool,
    aiGenerateDescription: bool,
    aiGenerateTags: bool,
    aiTone: str(100),
    aiLanguage: str(100),
    aiDescriptionLength: str(100),
    aiGuidelines: str(5000),
    veoModel: str(100),
    veoResolution: str(100),
    veoAspectRatio: str(100),
    veoDurationSeconds: int(1, 60),
    veoGenerateAudio: bool,
    veoEnhancePrompt: bool,
    veoPersonGeneration: str(100),
    veoNumberOfVideos: int(1, 4),
    resendApiKey: str(500),
    emailFromAddress: str(320),
    emailNotificationsEnabled: bool,
    deepseekApiKey: str(500),
    notifyOnPublishSuccess: bool,
    notifyOnPublishFailure: bool,
    notifyOnMetadataReady: bool,
    notifyOnWeeklyDigest: bool,
    notifyOnStorageWarning: bool,
    discordMessageTemplate: str(2000),
    telegramMessageTemplate: str(2000),
    competitorChannelIds: z.array(z.string().trim().min(1).max(100)).max(50).nullable().optional(),
    aiNiche: str(1000),
    aiTargetAudience: str(1000),
    aiBrandVoice: str(1000),
    aiForbiddenWords: str(2000),
    aiCtaPreferences: str(2000),
    humanizeWriting: bool,
  })
  // Unknown keys are rejected, not silently dropped: a typo or a probe for a protected column
  // (autoPublish*, userId, id) gets a 400 instead of looking like it worked.
  .strict();

export type SettingsUpdateInput = z.infer<typeof settingsUpdateInput>;

/** Empty string -> null (clears the column). */
const blankToNull = (v: string): string | null => (v.trim() === "" ? null : v.trim());

const SIMPLE_STRINGS = [
  "aiPreset",
  "defaultQuality",
  "defaultAspectRatio",
  "telegramChatId",
  "aiTone",
  "aiLanguage",
  "aiDescriptionLength",
  "aiGuidelines",
  "veoModel",
  "veoResolution",
  "veoAspectRatio",
  "veoPersonGeneration",
  "discordMessageTemplate",
  "telegramMessageTemplate",
  "aiNiche",
  "aiTargetAudience",
  "aiBrandVoice",
  "aiForbiddenWords",
  "aiCtaPreferences",
] as const satisfies readonly (keyof SettingsUpdateInput)[];

const PASSTHROUGH = [
  "defaultCaptions",
  "defaultBackgroundMusic",
  "notificationsEnabled",
  "aiAutoGenerate",
  "aiGenerateTitle",
  "aiGenerateDescription",
  "aiGenerateTags",
  "veoDurationSeconds",
  "veoGenerateAudio",
  "veoEnhancePrompt",
  "veoNumberOfVideos",
  "emailNotificationsEnabled",
  "notifyOnPublishSuccess",
  "notifyOnPublishFailure",
  "notifyOnMetadataReady",
  "notifyOnWeeklyDigest",
  "notifyOnStorageWarning",
  "humanizeWriting",
] as const satisfies readonly (keyof SettingsUpdateInput)[];

/**
 * A Discord webhook is an https URL on discord.com / discordapp.com (exact host: this is the
 * SSRF guard, since the server later POSTs to whatever is stored). No credentials, no custom port.
 */
export function validateDiscordWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw badRequest("Discord webhook URL is invalid");
  }
  const validHost = url.hostname === "discord.com" || url.hostname === "discordapp.com";
  if (url.protocol !== "https:" || !validHost || url.username || url.password || url.port || !url.pathname.startsWith("/api/webhooks/")) {
    throw badRequest("Discord webhook URL must be a valid https://discord.com/api/webhooks/... URL");
  }
  return url.toString();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** "Name <a@b.co>" or "a@b.co" */
function validateFromAddress(raw: string): string {
  const v = raw.trim();
  const bare = /<([^<>]+)>\s*$/.exec(v)?.[1] ?? v;
  if (!EMAIL_RE.test(bare) || /[\r\n]/.test(v)) throw badRequest("From address must be an email address like you@example.com");
  return v;
}

/** Turn validated input into the column values to write (only keys the caller sent). */
export function buildSettingsValues(args: SettingsUpdateInput): Partial<SettingsInsert> {
  const out: Record<string, unknown> = {};

  for (const k of SIMPLE_STRINGS) {
    const v = args[k];
    if (v !== undefined) out[k] = v === null ? null : blankToNull(v);
  }
  for (const k of PASSTHROUGH) {
    if (args[k] !== undefined) out[k] = args[k];
  }

  if (args.discordWebhookUrl !== undefined) {
    out.discordWebhookUrl = args.discordWebhookUrl === null || args.discordWebhookUrl.trim() === "" ? null : validateDiscordWebhookUrl(args.discordWebhookUrl);
  }
  if (args.emailFromAddress !== undefined) {
    out.emailFromAddress = args.emailFromAddress === null || args.emailFromAddress.trim() === "" ? null : validateFromAddress(args.emailFromAddress);
  }
  for (const k of ["resendApiKey", "deepseekApiKey"] as const) {
    const v = args[k];
    if (v !== undefined) out[k] = v === null || v.trim() === "" ? null : encryptSecret(v.trim());
  }
  if (args.competitorChannelIds !== undefined) {
    out.competitorChannelIds = args.competitorChannelIds === null || args.competitorChannelIds.length === 0 ? null : [...new Set(args.competitorChannelIds)];
  }
  return out as Partial<SettingsInsert>;
}

// ─── auto-publish ────────────────────────────────────────────────────────────

export const MIN_AUTO_PUBLISH_INTERVAL_MS = 3_600_000;

export const startAutoPublishInput = z.object({
  /** Epoch ms of the first run (the client computes it from the chosen slots). */
  scheduledAt: z.number().finite(),
  intervalMs: z.number().finite(),
  count: z.number().int().min(1).max(50),
  privacy: z.enum(PRIVACY_STATUSES),
  timeSlots: z.array(z.number().int().min(0).max(23)).max(24).optional(),
  timezoneOffset: z.number().finite().min(-12).max(14).optional(),
});

/** Cross-field checks that zod cannot express; throws BAD_REQUEST. */
export function assertAutoPublishArgs(a: z.infer<typeof startAutoPublishInput>): void {
  if (a.intervalMs < MIN_AUTO_PUBLISH_INTERVAL_MS) throw badRequest("Minimum auto-publish interval is 1 hour");
  if (a.intervalMs > 365 * 24 * MIN_AUTO_PUBLISH_INTERVAL_MS) throw badRequest("Auto-publish interval is too long");
}

// Single source of truth for auto-publish slot math lives with the publisher that consumes it.
export { nextSlotMs } from "@/server/lib/publish/schedule";
