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
import { FileState, type File as GeminiFile, type GoogleGenAI, type Part } from "@google/genai";
import { PermanentAiError, toTimeoutError, withDeadline } from "@/server/lib/ai";

const FRAME_TIMEOUT_MS = 15_000;
/** Files API fallback never pulls more than this into memory. */
const MAX_FILES_API_BYTES = 256 * 1024 * 1024;
/** Hard cap for ONE Files API request (the upload, or a status poll); each is also bounded by the time left. */
export const FILES_API_MAX_CALL_MS = 120_000;
/** A per-call timeout is never armed below this: the SDK reads a timeout of 0 as "no timeout". */
const FILES_API_MIN_CALL_MS = 1_000;
const FILES_API_POLL_INTERVAL_MS = 2_000;

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

/** Test hooks; production uses the defaults above. */
export type FilesApiOptions = { maxCallMs?: number; minCallMs?: number; pollIntervalMs?: number };

/**
 * Upload the whole video to the Gemini Files API and wait (until `deadlineAt`, epoch ms) for it to
 * become ACTIVE. The uploaded file is auto-deleted by Google after 48h.
 *
 * Every Google request is bounded by min(time left, FILES_API_MAX_CALL_MS) so a hung connection ends in a
 * retryable AiTimeoutError instead of holding the caller until the host kills it. The upload cannot take a
 * per-request timeout from the SDK (2.6.0 drops `config.httpOptions`/`abortSignal` for the chunk requests, and
 * `httpOptions` would replace the resumable-upload headers of the start request), so it is raced against a
 * timer and abandoned, not cancelled. The status poll uses the SDK's own `httpOptions.timeout` and is aborted.
 */
export async function geminiVideoFilePart(ai: GoogleGenAI, videoUrl: string, deadlineAt: number, opts: FilesApiOptions = {}): Promise<Part> {
  assertCloudinaryUrl(videoUrl);
  const left = () => Math.max(deadlineAt - Date.now(), 0);
  const minCallMs = opts.minCallMs ?? FILES_API_MIN_CALL_MS;
  const maxCallMs = opts.maxCallMs ?? FILES_API_MAX_CALL_MS;
  const callBudget = () => Math.min(Math.max(left(), minCallMs), maxCallMs);
  const pollIntervalMs = opts.pollIntervalMs ?? FILES_API_POLL_INTERVAL_MS;

  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(Math.max(left(), 1_000)) });
  if (!res.ok) throw new Error(`Could not fetch video for analysis: ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > MAX_FILES_API_BYTES) throw new PermanentAiError("Video is too large to analyse");
  const blob = await res.blob();
  if (blob.size > MAX_FILES_API_BYTES) throw new PermanentAiError("Video is too large to analyse");
  const mimeType = blob.type && blob.type !== "application/octet-stream" ? blob.type : "video/mp4";

  let file: GeminiFile = await withDeadline(
    ai.files.upload({ file: blob, config: { mimeType, displayName: "video" } }),
    "Gemini Files API upload",
    callBudget(),
  );
  while (file.state === FileState.PROCESSING) {
    if (left() < 3_000) throw new Error("Gemini is still processing the video; try again shortly");
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollMs = callBudget();
    try {
      file = await ai.files.get({ name: file.name as string, config: { httpOptions: { timeout: pollMs } } });
    } catch (e) {
      throw toTimeoutError(e, "Gemini Files API status check", pollMs);
    }
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
