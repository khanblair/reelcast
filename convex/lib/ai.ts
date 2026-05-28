"use node";

import { GoogleGenAI, GenerateVideosOperation } from "@google/genai";

// ---------------------------------------------------------------------------
// Client factory — returns Vertex AI client when service account creds are
// present, falls back to Gemini Developer API (AI Studio key) otherwise.
// ---------------------------------------------------------------------------
export function createAiClient(): { ai: GoogleGenAI; isVertexAI: boolean } {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const project            = process.env.GOOGLE_CLOUD_PROJECT;
  const location           = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

  if (serviceAccountJson && project) {
    const credentials = JSON.parse(serviceAccountJson);
    const ai = new GoogleGenAI({
      vertexai: true,
      project,
      location,
      googleAuthOptions: {
        credentials,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    });
    console.log(`[ai] Using Vertex AI — project=${project} location=${location}`);
    return { ai, isVertexAI: true };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("No AI credentials: set GOOGLE_SERVICE_ACCOUNT_JSON+GOOGLE_CLOUD_PROJECT (Vertex AI) or GEMINI_API_KEY (Developer API)");
  console.log("[ai] Using Gemini Developer API");
  return { ai: new GoogleGenAI({ apiKey }), isVertexAI: false };
}

// ---------------------------------------------------------------------------
// Model IDs
// Vertex AI uses the same short IDs — the SDK handles the publisher path.
// ---------------------------------------------------------------------------
export const VEO_MODEL_IDS: Record<string, string> = {
  "veo-3.1-preview":      "veo-3.1-generate-preview",
  "veo-3":                "veo-3.0-generate-001",
  "veo-3.1-fast-preview": "veo-3.1-fast-generate-preview",
  "veo-3-fast":           "veo-3.0-fast-generate-001",
  "veo-3.1-lite":         "veo-3.1-lite-generate-preview",
  "veo-2":                "veo-2.0-generate-001",
};

// generateAudio is supported on Vertex AI for all Veo 3 models.
// It is NOT available on the Gemini Developer API.
const AUDIO_CAPABLE_MODELS = new Set([
  "veo-3.1-preview",
  "veo-3",
  "veo-3.1-fast-preview",
  "veo-3-fast",
]);

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

// ---------------------------------------------------------------------------
// Submit a new generation
// ---------------------------------------------------------------------------
export async function submitVeoGeneration(
  params: VeoGenerationParams
): Promise<{ operationName: string }> {
  const { ai, isVertexAI } = createAiClient();
  const modelId = VEO_MODEL_IDS[params.model];
  if (!modelId) throw new Error(`Unknown Veo model: ${params.model}`);

  const supportsAudio = isVertexAI && AUDIO_CAPABLE_MODELS.has(params.model);

  console.log(`[submitVeoGeneration] model=${modelId} vertexAI=${isVertexAI} aspectRatio=${params.aspectRatio} resolution=${params.resolution} duration=${params.durationSeconds}s generateAudio=${supportsAudio ? (params.generateAudio ?? true) : "n/a (Developer API)"}`);

  const config: Record<string, unknown> = {
    numberOfVideos:  params.numberOfVideos  ?? 1,
    resolution:      params.resolution      ?? "720p",
    aspectRatio:     params.aspectRatio     ?? "16:9",
    durationSeconds: params.durationSeconds ?? 8,
    enhancePrompt:   params.enhancePrompt   ?? true,
    negativePrompt:  params.negativePrompt,
    seed:            params.seed,
  };

  if (supportsAudio) {
    config.generateAudio = params.generateAudio ?? true;
  }

  const operation = await ai.models.generateVideos({
    model: modelId,
    source: { prompt: params.prompt },
    config: config as Parameters<typeof ai.models.generateVideos>[0]["config"],
  });

  if (!operation.name) throw new Error("Veo operation returned without a name");
  return { operationName: operation.name };
}

// ---------------------------------------------------------------------------
// Poll an existing operation
// ---------------------------------------------------------------------------
export async function pollVeoOperation(
  operationName: string
): Promise<VeoOperationResult> {
  const { ai } = createAiClient();

  // getVideosOperation needs a proper GenerateVideosOperation instance —
  // it calls _fromAPIResponse() on it, so a plain object won't work.
  const stub = new GenerateVideosOperation();
  stub.name = operationName;

  const operation = await ai.operations.getVideosOperation({ operation: stub });

  if (!operation.done) return { operationName, done: false };

  if (operation.error) {
    const errMsg = operation.error.message || JSON.stringify(operation.error);
    throw new Error(`Veo generation failed: ${errMsg}`);
  }

  const generatedVideo = operation.response?.generatedVideos?.[0];
  const video = generatedVideo?.video;

  return {
    operationName,
    done: true,
    videoUri: video?.uri,
    videoBytesBase64: video?.videoBytes,
    videoMimeType: video?.mimeType ?? "video/mp4",
  };
}

// ---------------------------------------------------------------------------
// Upload raw video bytes to Cloudinary
// ---------------------------------------------------------------------------
export async function uploadVideoBytesToCloudinary(
  base64Video: string,
  mimeType: string,
  videoId: string
): Promise<{ secure_url: string; bytes: number }> {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary credentials not configured");
  }

  const crypto = await import("crypto");
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `generated/${videoId}_${timestamp}`;
  const signatureStr = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash("sha1").update(signatureStr).digest("hex");

  const formData = new FormData();
  formData.append("file", `data:${mimeType};base64,${base64Video}`);
  formData.append("public_id", publicId);
  formData.append("timestamp", timestamp.toString());
  formData.append("signature", signature);
  formData.append("api_key", apiKey);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
    { method: "POST", body: formData }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudinary upload failed: ${res.status} — ${body}`);
  }

  const data = await res.json();
  return { secure_url: data.secure_url, bytes: data.bytes ?? 0 };
}
