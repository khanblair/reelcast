/**
 * Gemini / Veo client plumbing. ALL Google AI client construction lives here.
 *
 *  - Veo (video generation) uses Vertex AI when GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_CLOUD_PROJECT
 *    are set, otherwise the Gemini Developer API with an API key (explicit `apiKey`, else
 *    GEMINI_API_KEY). Both are optional in dev.
 *  - Metadata / captions / thumbnails use the Developer API with the platform key
 *    (see platformKeys.ts) through `createGeminiClient`.
 */
import { GenerateVideosOperation, GoogleGenAI } from "@google/genai";

/** A failure no retry can fix (bad input, missing configuration, the provider rejected the job). */
export class PermanentAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentAiError";
  }
}

/** No usable credentials anywhere (permanent until an operator configures one). */
export class AiNotConfiguredError extends PermanentAiError {
  constructor(message: string) {
    super(message);
    this.name = "AiNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------
export function createAiClient(apiKeyOverride?: string | null): { ai: GoogleGenAI; isVertexAI: boolean } {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

  if (serviceAccountJson && project) {
    const credentials = JSON.parse(serviceAccountJson) as Record<string, unknown>;
    const ai = new GoogleGenAI({
      vertexai: true,
      project,
      location,
      googleAuthOptions: {
        credentials,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    });
    return { ai, isVertexAI: true };
  }

  const apiKey = apiKeyOverride || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AiNotConfiguredError("No AI credentials: set GOOGLE_SERVICE_ACCOUNT_JSON+GOOGLE_CLOUD_PROJECT (Vertex AI) or GEMINI_API_KEY (Developer API)");
  }
  return { ai: new GoogleGenAI({ apiKey }), isVertexAI: false };
}

/** Gemini Developer API client for text/vision calls (metadata, captions, thumbnails). */
export function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({ apiKey });
}

// ---------------------------------------------------------------------------
// Model IDs
// Vertex AI uses the same short IDs - the SDK handles the publisher path.
// ---------------------------------------------------------------------------
export const VEO_MODEL_IDS: Record<string, string> = {
  "veo-3.1-preview": "veo-3.1-generate-preview",
  "veo-3": "veo-3.0-generate-001",
  "veo-3.1-fast-preview": "veo-3.1-fast-generate-preview",
  "veo-3-fast": "veo-3.0-fast-generate-001",
  "veo-3.1-lite": "veo-3.1-lite-generate-preview",
  "veo-2": "veo-2.0-generate-001",
};

// generateAudio is supported on Vertex AI for all Veo 3 models.
// It is NOT available on the Gemini Developer API.
const AUDIO_CAPABLE_MODELS = new Set(["veo-3.1-preview", "veo-3", "veo-3.1-fast-preview", "veo-3-fast"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface VeoGenerationParams {
  model: string;
  prompt: string;
  negativePrompt?: string;
  resolution?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  numberOfVideos?: number;
  enhancePrompt?: boolean;
  generateAudio?: boolean;
  seed?: number;
}

export interface VeoOperationResult {
  operationName: string;
  done: boolean;
  videoUri?: string;
  videoBytesBase64?: string;
  videoMimeType?: string;
}

/** Thrown when Google reports the operation itself failed (permanent: retrying cannot help). */
export class VeoOperationError extends PermanentAiError {
  constructor(message: string) {
    super(message);
    this.name = "VeoOperationError";
  }
}

/** HTTP-ish status carried by SDK errors (`ApiError.status`), if any. */
export function aiErrorStatus(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

/** 4xx other than 408/429 are caller errors: a retry would fail identically. */
export function isPermanentAiError(e: unknown): boolean {
  if (e instanceof PermanentAiError) return true;
  const s = aiErrorStatus(e);
  return s !== null && s >= 400 && s < 500 && s !== 408 && s !== 429;
}

// ---------------------------------------------------------------------------
// Timeouts
// A hung Google call must fail fast so the job retries (3 attempts with backoff) instead of holding a
// serverless function, or a whole cron tick, until the host kills it at maxDuration (300 s).
// ---------------------------------------------------------------------------
/** Veo `generateVideos` submit: one small POST. */
export const VEO_SUBMIT_TIMEOUT_MS = 60_000;
/** Veo operation poll: one small GET, repeated every 15 s. */
export const VEO_POLL_TIMEOUT_MS = 30_000;

/**
 * A Google call did not answer in time. Deliberately NOT a PermanentAiError (and carries no HTTP status),
 * so `isPermanentAiError` is false and the job handler rethrows it as a plain Error: the queue retries.
 */
export class AiTimeoutError extends Error {
  constructor(label: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`, options);
    this.name = "AiTimeoutError";
  }
}

/** A request aborted by the SDK's `httpOptions.timeout` (AbortError) or by `AbortSignal.timeout` (TimeoutError). */
function isAbortLike(e: unknown): boolean {
  for (let cur = e as { name?: unknown; cause?: unknown } | null | undefined, depth = 0; cur && depth < 4; cur = cur.cause as typeof cur, depth++) {
    if (cur.name === "AbortError" || cur.name === "TimeoutError") return true;
  }
  return false;
}

/** Re-throw an aborted request as an AiTimeoutError (clear message, retryable); anything else passes through. */
export function toTimeoutError(e: unknown, label: string, timeoutMs: number): unknown {
  return isAbortLike(e) ? new AiTimeoutError(label, timeoutMs, { cause: e }) : e;
}

// ---------------------------------------------------------------------------
// Submit a new generation
// ---------------------------------------------------------------------------
export async function submitVeoGeneration(
  params: VeoGenerationParams,
  apiKey?: string | null,
  timeoutMs: number = VEO_SUBMIT_TIMEOUT_MS,
): Promise<{ operationName: string }> {
  const { ai, isVertexAI } = createAiClient(apiKey);
  const modelId = VEO_MODEL_IDS[params.model];
  if (!modelId) throw new VeoOperationError(`Unknown Veo model: ${params.model}`);

  const supportsAudio = isVertexAI && AUDIO_CAPABLE_MODELS.has(params.model);

  const config: Record<string, unknown> = {
    numberOfVideos: params.numberOfVideos ?? 1,
    resolution: params.resolution ?? "720p",
    aspectRatio: params.aspectRatio ?? "16:9",
    durationSeconds: params.durationSeconds ?? 8,
    enhancePrompt: params.enhancePrompt ?? true,
    negativePrompt: params.negativePrompt,
    seed: params.seed,
  };
  if (supportsAudio) config.generateAudio = params.generateAudio ?? true;

  // Trade-off (known, accepted): if the timeout fires AFTER Google accepted the request (a slow or lost
  // response), the caller sees a retryable failure, refunds the quota unit and submits again, so one
  // generation can be billed twice. Closing that window needs an intent row (SCALING-LADDER Q-8).
  config.httpOptions = { timeout: timeoutMs };
  let operation: GenerateVideosOperation;
  try {
    operation = await ai.models.generateVideos({
      model: modelId,
      source: { prompt: params.prompt },
      config: config as Parameters<typeof ai.models.generateVideos>[0]["config"],
    });
  } catch (e) {
    throw toTimeoutError(e, "Veo submit", timeoutMs);
  }

  if (!operation.name) throw new Error("Veo operation returned without a name");
  return { operationName: operation.name };
}

// ---------------------------------------------------------------------------
// Poll an existing operation (one request; callers schedule the next poll)
// ---------------------------------------------------------------------------
export async function pollVeoOperation(
  operationName: string,
  apiKey?: string | null,
  timeoutMs: number = VEO_POLL_TIMEOUT_MS,
): Promise<VeoOperationResult> {
  const { ai } = createAiClient(apiKey);

  // getVideosOperation needs a proper GenerateVideosOperation instance:
  // it calls _fromAPIResponse() on it, so a plain object won't work.
  const stub = new GenerateVideosOperation();
  stub.name = operationName;

  let operation: GenerateVideosOperation;
  try {
    operation = await ai.operations.getVideosOperation({ operation: stub, config: { httpOptions: { timeout: timeoutMs } } });
  } catch (e) {
    throw toTimeoutError(e, "Veo poll", timeoutMs);
  }

  if (!operation.done) return { operationName, done: false };

  if (operation.error) {
    const errMsg = typeof operation.error.message === "string" && operation.error.message ? operation.error.message : JSON.stringify(operation.error);
    throw new VeoOperationError(`Veo generation failed: ${errMsg}`);
  }

  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) {
    const reasons = operation.response?.raiMediaFilteredReasons?.filter(Boolean).join("; ");
    throw new VeoOperationError(reasons ? `Veo returned no video (filtered: ${reasons})` : "Veo returned no video data");
  }

  return {
    operationName,
    done: true,
    videoUri: video.uri,
    videoBytesBase64: video.videoBytes,
    videoMimeType: video.mimeType ?? "video/mp4",
  };
}

// ---------------------------------------------------------------------------
// Download Veo output as a stream (Developer API Files URIs need the API key).
// Google deletes the file after ~2 days, so callers copy it to durable storage at once.
// ---------------------------------------------------------------------------
export async function openVeoDownload(videoUri: string, apiKey: string): Promise<Response> {
  if (!/^https:\/\/generativelanguage\.googleapis\.com\//.test(videoUri)) {
    throw new VeoOperationError("Veo output location is not a downloadable Gemini Files URI");
  }
  // Files API media download is `<files/id>:download?alt=media`. Developer-API Veo URIs may already
  // carry the `:download?alt=media` suffix or be the bare resource: normalise both.
  const base = videoUri.split("?")[0].replace(/:download$/, "");
  const attempts = [`${base}:download?alt=media`, `${base}?alt=media`];
  let last: Response | null = null;
  for (const url of attempts) {
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(100_000) });
    if (res.ok && res.body) return res;
    last = res;
    await res.body?.cancel().catch(() => {});
  }
  throw new Error(`Failed to download Veo video: ${last?.status ?? "no response"} ${last?.statusText ?? ""}`.trim());
}
