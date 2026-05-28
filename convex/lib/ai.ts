"use node";

import { GoogleGenAI, GenerateVideosOperation } from "@google/genai";

const API_KEY = process.env.GEMINI_API_KEY!;

// Models available via Gemini Developer API (AI Studio key).
// generateAudio and personGeneration require Vertex AI / Enterprise — never pass them here.
export const VEO_MODEL_IDS: Record<string, string> = {
  "veo-2":      "veo-2.0-generate-001",   // stable, widely available on Developer API
  "veo-3-fast": "veo-3.0-fast-generate-001", // available on paid Developer API tiers
};

export interface VeoGenerationParams {
  model: string;
  prompt: string;
  negativePrompt?: string;
  resolution?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  numberOfVideos?: number;
  enhancePrompt?: boolean;
  seed?: number;
  // NOTE: generateAudio and personGeneration are Vertex AI / Enterprise only — omitted
}

export interface VeoOperationResult {
  operationName: string;
  done: boolean;
  videoUri?: string;
  videoBytesBase64?: string;
  videoMimeType?: string;
}

export async function submitVeoGeneration(
  params: VeoGenerationParams
): Promise<{ operationName: string }> {
  const ai = new GoogleGenAI({ apiKey: API_KEY });
  const modelId = VEO_MODEL_IDS[params.model];
  if (!modelId) {
    throw new Error(`Unknown Veo model: ${params.model}`);
  }

  console.log(`[submitVeoGeneration] model=${modelId} aspectRatio=${params.aspectRatio} resolution=${params.resolution} duration=${params.durationSeconds}s`);

  const operation = await ai.models.generateVideos({
    model: modelId,
    source: { prompt: params.prompt },
    config: {
      numberOfVideos: params.numberOfVideos ?? 1,
      resolution:     params.resolution     ?? "720p",
      aspectRatio:    params.aspectRatio    ?? "16:9",
      durationSeconds: params.durationSeconds ?? 8,
      enhancePrompt:  params.enhancePrompt  ?? true,
      negativePrompt: params.negativePrompt,
      seed:           params.seed,
      // generateAudio and personGeneration intentionally omitted — Developer API only
    },
  });

  if (!operation.name) {
    throw new Error("Veo operation returned without a name");
  }

  return { operationName: operation.name };
}

export async function pollVeoOperation(
  operationName: string
): Promise<VeoOperationResult> {
  const ai = new GoogleGenAI({ apiKey: API_KEY });

  // getVideosOperation requires a proper GenerateVideosOperation instance
  // (it calls operation._fromAPIResponse internally — a plain object won't work).
  const stub = new GenerateVideosOperation();
  stub.name = operationName;

  const operation = await ai.operations.getVideosOperation({ operation: stub });

  if (!operation.done) {
    return { operationName, done: false };
  }

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

export async function uploadVideoBytesToCloudinary(
  base64Video: string,
  mimeType: string,
  videoId: string
): Promise<{ secure_url: string; bytes: number }> {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
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
