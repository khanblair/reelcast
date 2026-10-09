/**
 * Video access helpers shared by metadata / captions / thumbnail generation.
 *
 *  - Cloudinary-hosted videos are analysed through a few JPEG frames (cheap, fast, ~1k tokens).
 *  - Anything that fails that path falls back to the Gemini Files API (expensive, slow) under a
 *    hard deadline so a request/task can never run unbounded.
 *
 * SSRF: video URLs come from rows the browser can write (`videos.rawFileKey`), so the server only
 * ever fetches https URLs on Cloudinary hosts.
 */
import { FileState, type GoogleGenAI, type Part } from "@google/genai";
import { PermanentAiError } from "@/server/lib/ai";

const FRAME_TIMEOUT_MS = 15_000;
/** Files API fallback never pulls more than this into memory. */
const MAX_FILES_API_BYTES = 256 * 1024 * 1024;

const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|flv|wmv)(\?.*)?$/;

export function isCloudinaryUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.username === "" && u.password === "" && (u.hostname === "cloudinary.com" || u.hostname.endsWith(".cloudinary.com"));
  } catch {
    return false;
  }
}

export function assertCloudinaryUrl(url: string | null | undefined): string {
  if (!isCloudinaryUrl(url)) throw new PermanentAiError("Unsupported video location (expected a Cloudinary https URL)");
  return url as string;
}

/** `https://res.cloudinary.com/x/video/upload/v1/a.mp4` -> JPEG frame URL with `transform` applied. */
export function frameUrl(videoUrl: string, transform: string): string {
  return videoUrl.replace("/upload/", `/upload/${transform},w_640,h_360,c_fill/`).replace(VIDEO_EXT, ".jpg");
}

export type Frame = { transform: string; base64: string };

/** Fetch frames in parallel; frames that fail are dropped (callers decide what "too few" means). */
export async function fetchFrames(videoUrl: string, transforms: string[], timeoutMs = FRAME_TIMEOUT_MS): Promise<Frame[]> {
  assertCloudinaryUrl(videoUrl);
  const settled = await Promise.allSettled(
    transforms.map(async (t) => {
      const res = await fetch(frameUrl(videoUrl, t), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`frame ${res.status}`);
      return { transform: t, base64: Buffer.from(await res.arrayBuffer()).toString("base64") };
    }),
  );
  return settled.filter((r): r is PromiseFulfilledResult<Frame> => r.status === "fulfilled").map((r) => r.value);
}

export const framePart = (f: Frame): Part => ({ inlineData: { data: f.base64, mimeType: "image/jpeg" } });

/**
 * Upload the whole video to the Gemini Files API and wait (until `deadlineAt`, epoch ms) for it to
 * become ACTIVE. The uploaded file is auto-deleted by Google after 48h.
 */
export async function geminiVideoFilePart(ai: GoogleGenAI, videoUrl: string, deadlineAt: number): Promise<Part> {
  assertCloudinaryUrl(videoUrl);
  const left = () => Math.max(deadlineAt - Date.now(), 0);

  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(Math.max(left(), 1_000)) });
  if (!res.ok) throw new Error(`Could not fetch video for analysis: ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > MAX_FILES_API_BYTES) throw new PermanentAiError("Video is too large to analyse");
  const blob = await res.blob();
  if (blob.size > MAX_FILES_API_BYTES) throw new PermanentAiError("Video is too large to analyse");
  const mimeType = blob.type && blob.type !== "application/octet-stream" ? blob.type : "video/mp4";

  let file = await ai.files.upload({ file: blob, config: { mimeType, displayName: "video" } });
  while (file.state === FileState.PROCESSING) {
    if (left() < 3_000) throw new Error("Gemini is still processing the video; try again shortly");
    await new Promise((r) => setTimeout(r, 2_000));
    file = await ai.files.get({ name: file.name as string });
  }
  if (file.state === FileState.FAILED || !file.uri) throw new PermanentAiError("Gemini file processing failed.");
  return { fileData: { fileUri: file.uri, mimeType } };
}

/** Strip markdown fences and parse JSON the way Convex did (raw first, then fence-stripped). */
export function parseJsonLoose<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned) as T;
  }
}
