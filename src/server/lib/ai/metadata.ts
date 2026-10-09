/**
 * Gemini-backed YouTube metadata generation (ports convex/actions/metadata.ts).
 * Pure AI + persistence helpers; quota, auth and scheduling live in the callers.
 */
import { eq, sql } from "drizzle-orm";
import type { GoogleGenAI, Part } from "@google/genai";
import type { DbLike } from "@/db/client";
import { videoMetadataVersions, videos } from "@/db/schema";
import { HUMANIZE_METADATA_RULES } from "@/server/lib/humanizePrompt";
import { fetchFrames, framePart, geminiVideoFilePart, isCloudinaryUrl, parseJsonLoose } from "./video";

export const GEMINI_MODEL = "gemini-2.5-flash";

export type VideoMetadata = { title: string; description: string; tags: string[] };

const MAX_TITLE = 100; // YouTube hard limit
const MAX_DESCRIPTION = 5000; // YouTube hard limit
const MAX_VERSIONS = 10;

/** Frames used to "watch" a Cloudinary video: start, 25 %, 75 % (~1.2k image tokens total). */
const METADATA_FRAMES = ["so_0", "so_25p", "so_75p"];

function humanizeBlock(humanize: boolean | undefined | null): string {
  return humanize ? `\n\n${HUMANIZE_METADATA_RULES}` : "";
}

export function promptOnlyPrompt(opts: { prompt: string; humanize?: boolean | null }): string {
  return `You are a YouTube Shorts metadata specialist with deep knowledge of YouTube SEO and the VidIQ ranking methodology.${humanizeBlock(opts.humanize)}

A YouTube Short is being generated from this AI prompt: "${opts.prompt}"

Return ONLY this JSON — no markdown, no explanation:
{
  "title": "...",
  "description": "...",
  "tags": [...]
}

TITLE (max 55 chars): Write a curiosity-gap or emotional-tension hook. Use patterns like "Why [unexpected claim]", "The Truth About [topic]", "Stop [common action] — Here's Why". Include the specific topic keyword. No hashtags, no ALL CAPS.

DESCRIPTION: Line 1 (100 chars, search snippet): punchy expansion of the title hook. Line 2: what the viewer gains. Line 3: call to action (e.g. "Follow for daily drops"). Line 4: hashtags — always start with #Shorts then 3-4 niche tags.

TAGS (12-15, VidIQ tiered): 2 broad ("shorts" + one category), 3-4 medium niche, 5-6 specific to this video's topic/emotion/scenario, 2-3 long-tail phrase tags people actually search. Never use "viral", "trending", "fyp", "motivationalvideo".`;
}

export function videoPrompt(opts: { hint: string; guidelines?: string | null; tone?: string | null; humanize?: boolean | null }): string {
  return `You are a YouTube Shorts metadata specialist with deep knowledge of YouTube SEO and the VidIQ ranking methodology.${humanizeBlock(opts.humanize)}

This is a YouTube Short (vertical video, under 60 seconds). Working title: "${opts.hint}".${opts.guidelines ? `\nChannel guidelines: ${opts.guidelines}` : ""}${opts.tone ? `\nContent tone: ${opts.tone}` : ""}

Analyze the video frames provided:
• Read ALL text overlays, quotes, and captions word-for-word
• Identify the speaker or person quoted if visible
• Capture the single core message or emotional insight

Return ONLY this JSON — no markdown, no explanation:
{
  "title": "...",
  "description": "...",
  "tags": [...]
}

═══ TITLE ═══ (max 55 chars — strict)
Write a curiosity-gap or emotional-tension hook that makes viewers NEED to watch.
Winning patterns:
  • "Why [unexpected claim about common belief]"
  • "The [number] [topic] Nobody Talks About"
  • "Stop [common action] — Here's Why"
  • "[Surprising emotional statement]"
  • "The Truth About [relatable struggle]"
Rules:
  ✓ Include the specific topic keyword (what the video is actually about)
  ✓ Create an open loop — viewer must watch to close it
  ✓ Use strong, concrete words — NOT "amazing", "inspiring", "motivational"
  ✗ No hashtags in the title. No ellipsis. No ALL CAPS.

═══ DESCRIPTION ═══
Line 1 (first 100 chars = YouTube search snippet): one specific, punchy statement expanding the title hook with a concrete detail from the video.
Line 2: What the viewer will feel, learn, or realise from watching.
Line 3: Call to action — e.g. "Follow for daily drops" or "Share this with someone who needs to hear it today."
Line 4: Hashtags on their own line — ALWAYS start with #Shorts, then 3-4 topic/niche hashtags (e.g. #Shorts #Mindset #SelfImprovement #Faith).
#Shorts is MANDATORY — the YouTube algorithm uses it to classify Shorts correctly.

═══ TAGS ═══ (12-15 tags total, tiered by competition — VidIQ methodology)
Tier 1 — Broad, high-volume (2 tags): "shorts", and ONE other broad category word
Tier 2 — Medium competition (3-4 tags): niche words like "selfimprovement", "mindset", "success", "inspiration", "faith"
Tier 3 — Specific to THIS video (5-6 tags): the exact topic, speaker name or quote keyword, the core emotion, the situation or scenario described in the video
Tier 4 — Long-tail phrase tags (2-3 tags): 3-5 word phrases people actually search (e.g. "morning motivation shorts 2026", "faith over fear quotes", "mindset shift for success")
NEVER include: "viral", "trending", "fyp", "foryoupage", "motivationalvideo" — YouTube ignores these and they dilute relevance.`;
}

/** Normalise whatever Gemini returned; throws when there is nothing usable. */
export function normalizeMetadata(raw: { title?: unknown; description?: unknown; tags?: unknown }, fallbackTitle: string): VideoMetadata {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim()) : [];
  if (!title && !description && tags.length === 0) throw new Error("Gemini returned no metadata");
  return {
    title: (title || fallbackTitle).slice(0, MAX_TITLE),
    description: description.slice(0, MAX_DESCRIPTION),
    tags,
  };
}

async function callGemini(ai: GoogleGenAI, parts: Part[], timeoutMs: number): Promise<string> {
  const res = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ role: "user", parts }],
    config: { responseMimeType: "application/json", httpOptions: { timeout: timeoutMs } },
  });
  return res.text ?? "";
}

/** Metadata from the generation prompt alone (used after a Veo video finishes). */
export async function generateMetadataFromPrompt(
  ai: GoogleGenAI,
  opts: { prompt: string; humanize?: boolean | null; fallbackTitle: string; timeoutMs?: number },
): Promise<VideoMetadata> {
  const text = await callGemini(ai, [{ text: promptOnlyPrompt(opts) }], opts.timeoutMs ?? 45_000);
  return normalizeMetadata(parseJsonLoose(text), opts.fallbackTitle);
}

/** Frames were unavailable and the caller forbade the (slow) Files API fallback. */
export class FramesUnavailableError extends Error {
  constructor() {
    super("Video frames are not available for quick analysis");
    this.name = "FramesUnavailableError";
  }
}

/**
 * Parts that let Gemini "see" a video: frames for Cloudinary videos, otherwise (or when every frame
 * fetch fails) the Files API under `deadlineAt` - unless `allowFilesApi` is false, in which case
 * `FramesUnavailableError` is thrown so the caller can hand the work to a background task.
 */
export async function buildVideoParts(ai: GoogleGenAI, videoUrl: string, opts: { deadlineAt: number; allowFilesApi: boolean }): Promise<Part[]> {
  if (isCloudinaryUrl(videoUrl)) {
    const frames = await fetchFrames(videoUrl, METADATA_FRAMES);
    if (frames.length > 0) return frames.map(framePart);
    console.warn("[ai/metadata] Cloudinary frame extraction failed");
  }
  if (!opts.allowFilesApi) throw new FramesUnavailableError();
  return [await geminiVideoFilePart(ai, videoUrl, opts.deadlineAt)];
}

/** Metadata from the actual video content. */
export async function generateMetadataFromVideo(
  ai: GoogleGenAI,
  opts: {
    videoUrl: string;
    hint: string;
    guidelines?: string | null;
    tone?: string | null;
    humanize?: boolean | null;
    /** Epoch ms after which Files API work gives up. */
    deadlineAt: number;
    /** false: throw FramesUnavailableError instead of falling back to the slow Files API. */
    allowFilesApi: boolean;
    timeoutMs?: number;
  },
): Promise<VideoMetadata> {
  const videoParts = await buildVideoParts(ai, opts.videoUrl, opts);
  const text = await callGemini(ai, [...videoParts, { text: videoPrompt(opts) }], opts.timeoutMs ?? 45_000);
  return normalizeMetadata(parseJsonLoose(text), opts.hint);
}

/**
 * Store AI metadata on a video, pushing the previous values into `video_metadata_versions`
 * (last 10 kept) - the Postgres form of Convex `metadataHistory`.
 */
export async function saveVideoMetadata(db: DbLike, videoId: string, meta: VideoMetadata): Promise<void> {
  await db.transaction(async (tx) => {
    const [cur] = await tx
      .select({ aiTitle: videos.aiTitle, aiDescription: videos.aiDescription, aiTags: videos.aiTags })
      .from(videos)
      .where(eq(videos.id, videoId))
      .for("update")
      .limit(1);
    if (!cur) return;
    if (cur.aiTitle || cur.aiDescription || cur.aiTags) {
      await tx.insert(videoMetadataVersions).values({ videoId, aiTitle: cur.aiTitle, aiDescription: cur.aiDescription, aiTags: cur.aiTags });
      await tx.execute(sql`
        delete from video_metadata_versions
        where video_id = ${videoId}
          and id not in (
            select id from video_metadata_versions where video_id = ${videoId} order by saved_at desc limit ${MAX_VERSIONS}
          )
      `);
    }
    await tx
      .update(videos)
      .set({ aiTitle: meta.title, aiDescription: meta.description, aiTags: meta.tags, updatedAt: new Date() })
      .where(eq(videos.id, videoId));
  });
}
