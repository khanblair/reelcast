# ReelCast — Veo 3.1 Fast & Veo 3 Fast Integration Plan

## Executive Summary

Integrate Google's Veo video generation models (`veo-3.1-fast-generate-001` and `veo-3.0-fast-generate-001`) into ReelCast to enable AI video generation from text prompts, with audio. Default: **720p resolution**, configurable per-generation and in global settings. The existing `@google/genai` SDK (v2.6.0) already supports `ai.models.generateVideos()` with full Veo operation polling.

**Confirmed**: `GEMINI_API_KEY` is set in `.env.local` — this key works for Veo via the Gemini API endpoint.

---

## Architecture Overview

```
User Prompt → Frontend Form → Convex Action (Node.js) → @google/genai SDK → Veo API
                                      ↓
                              Long-running Operation (polling)
                                      ↓
                         Video bytes → Cloudinary/Storage URL
                                      ↓
                    Update Convex DB (status: ready, processedFileKey, thumbnailUrl)
                                      ↓
                              Frontend live update via Convex subscription
```

---

## Phase 1 — Backend: Schema & Data Model

### 1.1 Convex Schema Updates (`convex/schema.ts`)

Add Veo-specific fields to the `videos` table:

```ts
// In videos table — REPLACE the existing aiConfig field:
aiConfig: v.optional(
  v.object({
    // ── Veo Generation Settings ──
    model: v.optional(v.string()),           // "veo-3.1-fast" | "veo-3-fast"
    prompt: v.optional(v.string()),          // Text prompt for video generation
    negativePrompt: v.optional(v.string()),  // What to avoid
    resolution: v.optional(v.string()),      // "720p" | "1080p"
    aspectRatio: v.optional(v.string()),     // "16:9" | "9:16" | "1:1"
    durationSeconds: v.optional(v.number()), // 5-8 seconds for Veo Fast
    fps: v.optional(v.number()),             // Frame rate
    generateAudio: v.optional(v.boolean()),  // Generate audio with video
    enhancePrompt: v.optional(v.boolean()),  // Use prompt rewriting
    numberOfVideos: v.optional(v.number()),  // 1 (default) or 2
    personGeneration: v.optional(v.string()),// "dont_allow" | "allow_adult"
    seed: v.optional(v.number()),            // Reproducible generation

    // ── Legacy / metadata fields ──
    preset: v.optional(v.string()),
    quality: v.optional(v.string()),
    captions: v.optional(v.boolean()),
    backgroundMusic: v.optional(v.boolean()),
  })
),

// NEW: Track Veo operation for polling
veoOperationName: v.optional(v.string()),     // Long-running operation ID
veoOperationDone: v.optional(v.boolean()),    // Operation completion flag
```

Add to the `settings` table:

```ts
// In settings table — add these fields:
veoModel: v.optional(v.string()),             // "veo-3.1-fast" | "veo-3-fast"
veoResolution: v.optional(v.string()),        // "720p" | "1080p"
veoAspectRatio: v.optional(v.string()),       // "16:9" | "9:16" | "1:1"
veoDurationSeconds: v.optional(v.number()),   // 5-8
veoGenerateAudio: v.optional(v.boolean()),     // true by default
veoEnhancePrompt: v.optional(v.boolean()),     // true by default
veoPersonGeneration: v.optional(v.string()),   // "dont_allow"
veoNumberOfVideos: v.optional(v.number()),     // 1
```

Add a new `generations` table for detailed generation history:

```ts
generations: defineTable({
  userId: v.id("users"),
  videoId: v.id("videos"),
  model: v.string(),                          // "veo-3.1-fast-generate-001" etc.
  prompt: v.string(),
  negativePrompt: v.optional(v.string()),
  resolution: v.string(),                     // "720p"
  aspectRatio: v.string(),                    // "16:9"
  durationSeconds: v.number(),
  generateAudio: v.boolean(),
  status: v.union(
    v.literal("submitted"),
    v.literal("processing"),
    v.literal("completed"),
    v.literal("failed")
  ),
  veoOperationName: v.optional(v.string()),
  outputVideoUrl: v.optional(v.string()),
  outputVideoBytes: v.optional(v.string()),   // Base64 — only for small/short clips
  thumbnailUrl: v.optional(v.string()),
  error: v.optional(v.string()),
  tokensUsed: v.optional(v.number()),
  generationTimeMs: v.optional(v.number()),
}).index("by_user", ["userId"])
  .index("by_video", ["videoId"])
  .index("by_status", ["status"]),
```

### 1.2 Video Status Flow Update

The pipeline changes from upload-centric to generation-centric:

```
draft → (user writes prompt + config) → queued → generating → ready → [publish flow]
                                                       ↑
                                              Veo operation polling
```

- `draft` — Video record created, awaiting prompt/configuration
- `queued` — User triggered generation, waiting for Veo API
- `generating` — Veo operation accepted, polling for completion
- `ready` — Video generated successfully, stored in cloud
- `failed` — Veo API error, timeout, or content filter rejection

---

## Phase 2 — Backend: Veo API Integration

### 2.1 Veo Client Wrapper (`convex/lib/ai.ts`)

```ts
"use node";

import { GoogleGenAI } from "@google/genai";

const API_KEY = process.env.GEMINI_API_KEY!;

export const VEO_MODELS = {
  "veo-3.1-fast": "veo-3.1-fast-generate-001",
  "veo-3-fast": "veo-3.0-fast-generate-001",
} as const;

export type VeoModelKey = keyof typeof VEO_MODELS;

export interface VeoGenerationParams {
  model: VeoModelKey;
  prompt: string;
  negativePrompt?: string;
  resolution?: string;       // "720p" | "1080p"
  aspectRatio?: string;       // "16:9" | "9:16" | "1:1"
  durationSeconds?: number;   // 5-8 for Fast models
  fps?: number;
  generateAudio?: boolean;
  enhancePrompt?: boolean;
  numberOfVideos?: number;
  personGeneration?: string;
  seed?: number;
}

export interface VeoGenerationResult {
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
  const modelId = VEO_MODELS[params.model];

  const operation = await ai.models.generateVideos({
    model: modelId,
    source: {
      prompt: params.prompt,
    },
    config: {
      numberOfVideos: params.numberOfVideos ?? 1,
      resolution: params.resolution ?? "720p",
      aspectRatio: params.aspectRatio ?? "16:9",
      durationSeconds: params.durationSeconds ?? 8,
      fps: params.fps,
      generateAudio: params.generateAudio ?? true,
      enhancePrompt: params.enhancePrompt ?? true,
      negativePrompt: params.negativePrompt,
      personGeneration: params.personGeneration,
      seed: params.seed,
    },
  });

  return {
    operationName: operation.name ?? "",
  };
}

export async function pollVeoOperation(
  operationName: string
): Promise<VeoGenerationResult> {
  const ai = new GoogleGenAI({ apiKey: API_KEY });

  const operation = await ai.operations.getVideosOperation({
    operation: { name: operationName } as any,
  });

  if (!operation.done) {
    return { operationName, done: false };
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
```

### 2.2 Convex Actions

#### `convex/actions/generation.ts` — Start Veo Generation

```ts
"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { submitVeoGeneration, type VeoModelKey } from "../lib/ai";

export const startGeneration = action({
  args: {
    videoId: v.id("videos"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    // 1. Get video + user settings
    const video = await ctx.runQuery(internal.videos.internalGet, {
      id: args.videoId,
    });
    if (!video) throw new Error("Video not found");

    const settings = await ctx.runQuery(internal.settings.getByVideoUserId, {
      userId: video.userId,
    });

    // 2. Merge: per-video config > user defaults > system defaults
    const aiConfig = video.aiConfig ?? {};
    const model = (aiConfig.model ?? settings?.veoModel ?? "veo-3.1-fast") as VeoModelKey;
    const prompt = aiConfig.prompt ?? video.title;
    const resolution = aiConfig.resolution ?? settings?.veoResolution ?? "720p";
    const aspectRatio = aiConfig.aspectRatio ?? settings?.veoAspectRatio ?? "16:9";
    const durationSeconds = aiConfig.durationSeconds ?? settings?.veoDurationSeconds ?? 8;
    const generateAudio = aiConfig.generateAudio ?? settings?.veoGenerateAudio ?? true;

    // 3. Submit to Veo
    try {
      const result = await submitVeoGeneration({
        model,
        prompt,
        negativePrompt: aiConfig.negativePrompt,
        resolution,
        aspectRatio,
        durationSeconds,
        generateAudio,
        enhancePrompt: aiConfig.enhancePrompt ?? settings?.veoEnhancePrompt ?? true,
        numberOfVideos: aiConfig.numberOfVideos ?? 1,
        personGeneration: aiConfig.personGeneration ?? settings?.veoPersonGeneration,
      });

      // 4. Store operation name + mark generating
      await ctx.runMutation(internal.videos.internalUpdateVeoOperation, {
        id: args.videoId,
        veoOperationName: result.operationName,
        veoOperationDone: false,
      });

      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "generating",
      });

      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "processing",
      });

      // 5. Schedule polling (every 15 seconds for up to 10 minutes)
      await ctx.scheduler.runAfter(
        15_000,
        internal.scheduled.runGeneration.pollVeoOperation,
        { jobId: args.jobId, videoId: args.videoId, attempt: 1, maxAttempts: 40 }
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "failed",
        error: `Veo submission failed: ${message}`,
      });
      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "failed",
      });
    }
  },
});
```

#### `convex/scheduled/runGeneration.ts` — Poll Veo Operation

```ts
"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { pollVeoOperation } from "../lib/ai";

export const pollVeoOperation = action({
  args: {
    jobId: v.id("jobs"),
    videoId: v.id("videos"),
    attempt: v.number(),
    maxAttempts: v.number(),
  },
  handler: async (ctx, args) => {
    const video = await ctx.runQuery(internal.videos.internalGet, {
      id: args.videoId,
    });
    if (!video || !video.veoOperationName) {
      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "failed",
        error: "Video or operation not found during polling",
      });
      return;
    }

    try {
      const result = await pollVeoOperation(video.veoOperationName);

      if (!result.done) {
        if (args.attempt >= args.maxAttempts) {
          throw new Error("Generation timed out after 10 minutes");
        }
        // Re-schedule poll
        await ctx.scheduler.runAfter(
          15_000,
          internal.scheduled.runGeneration.pollVeoOperation,
          {
            jobId: args.jobId,
            videoId: args.videoId,
            attempt: args.attempt + 1,
            maxAttempts: args.maxAttempts,
          }
        );
        return;
      }

      // ── Generation complete ──

      // Option A: Video URI available (cloud storage)
      let processedFileKey: string;
      if (result.videoUri) {
        processedFileKey = result.videoUri;
      } else if (result.videoBytesBase64) {
        // Option B: Upload base64 video bytes to Cloudinary
        const uploadResult = await uploadBase64ToCloudinary(
          result.videoBytesBase64,
          result.videoMimeType ?? "video/mp4",
          video._id
        );
        processedFileKey = uploadResult.secure_url;
      } else {
        throw new Error("No video data returned from Veo");
      }

      // Update video with generated file
      await ctx.runMutation(internal.videos.internalUpdateProcessedFile, {
        id: args.videoId,
        processedFileKey,
        veoOperationDone: true,
      });

      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "ready",
      });

      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "completed",
      });

      // Also run metadata generation using Gemini
      await ctx.scheduler.runAfter(0, internal.actions.metadata.generateFromPrompt, {
        videoId: args.videoId,
        prompt: video.aiConfig?.prompt ?? video.title,
      });

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await ctx.runMutation(internal.jobs.internalUpdateStatus, {
        id: args.jobId,
        status: "failed",
        error: message,
      });
      await ctx.runMutation(internal.videos.internalUpdateStatus, {
        id: args.videoId,
        status: "failed",
      });
    }
  },
});

async function uploadBase64ToCloudinary(
  base64: string,
  mimeType: string,
  videoId: string
): Promise<{ secure_url: string }> {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  const bytes = Buffer.from(base64, "base64");
  const formData = new FormData();
  formData.append("file", `data:${mimeType};base64,${base64}`);
  formData.append("upload_preset", "reelcast_generated");
  formData.append("public_id", `generated/${videoId}_${Date.now()}`);
  formData.append("api_key", apiKey!);

  // Use signed upload for server-side
  const crypto = await import("crypto");
  const timestamp = Math.floor(Date.now() / 1000);
  const signatureStr = `public_id=generated/${videoId}_${Date.now()}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash("sha1").update(signatureStr).digest("hex");

  formData.append("timestamp", timestamp.toString());
  formData.append("signature", signature);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
    { method: "POST", body: formData }
  );

  if (!res.ok) {
    throw new Error(`Cloudinary upload failed: ${res.statusText}`);
  }

  return await res.json();
}
```

### 2.3 New Internal Mutations (add to `convex/videos.ts`)

```ts
export const internalUpdateVeoOperation = internalMutation({
  args: {
    id: v.id("videos"),
    veoOperationName: v.string(),
    veoOperationDone: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      veoOperationName: args.veoOperationName,
      veoOperationDone: args.veoOperationDone,
    });
  },
});

export const internalUpdateProcessedFile = internalMutation({
  args: {
    id: v.id("videos"),
    processedFileKey: v.string(),
    veoOperationDone: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      processedFileKey: args.processedFileKey,
      veoOperationDone: args.veoOperationDone,
    });
  },
});
```

### 2.4 New Settings Query (add to `convex/settings.ts`)

```ts
export const getByVideoUserId = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("settings")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
  },
});
```

---

## Phase 3 — Frontend: Generation UI

### 3.1 New Generation Page — `/generate` (`src/app/(app)/generate/page.tsx`)

A dedicated "Generate Video" page (replaces the upload-centric flow for AI generation):

```
┌──────────────────────────────────────────────────────────────┐
│  Generate Video with AI                                       │
│  Create stunning videos from text prompts using Veo AI        │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─ Model Selection ──────────────────────────────────────┐  │
│  │  [Veo 3.1 Fast ●]  [Veo 3 Fast ○]                     │  │
│  │  Latest model. Fast generation with audio.              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ Prompt ───────────────────────────────────────────────┐  │
│  │  Describe your video...                                 │  │
│  │  [____________________________________________]         │  │
│  │  [____________________________________________]         │  │
│  │  [____________________________________________]         │  │
│  │                                                         │  │
│  │  Negative prompt (optional)                             │  │
│  │  [____________________________________________]         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─ Configuration ────────────────────────────────────────┐  │
│  │  Resolution        Aspect Ratio     Duration    Audio  │  │
│  │  [720p ▼]          [16:9 ▼]        [8s ───●]  [✓]    │  │
│  │                                                         │  │
│  │  □ Enhance prompt   □ Allow adult persons              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  [                         Generate Video                   ]  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Components to Build

#### `src/components/generation/prompt-editor.tsx`
- Rich textarea for prompt (min 10 chars, max 2000 chars)
- Character counter
- Negative prompt field (collapsible)
- Prompt suggestions / presets ("Cinematic landscape", "Product showcase", etc.)

#### `src/components/generation/model-selector.tsx`
- Radio/toggle between Veo 3.1 Fast and Veo 3 Fast
- Model description card showing capabilities
- Badge: "Recommended" on Veo 3.1 Fast
- Pricing hint per model

#### `src/components/generation/config-panel.tsx`
- **Resolution**: Select — 720p (default, highlighted), 1080p
- **Aspect Ratio**: Visual selector — 16:9, 9:16, 1:1 with mini preview rectangles
- **Duration**: Slider — 5s to 8s (Fast model limits)
- **Audio**: Toggle — Generate audio (default: on)
- **Enhance Prompt**: Toggle — Let AI improve prompt (default: on)
- **Person Generation**: Select — Don't allow / Allow adult

#### `src/components/generation/generation-progress.tsx`
- Animated progress states:
  - "Submitting to Veo..." (pulsing dot)
  - "Generating video... ~40% complete" (progress bar, estimated)
  - "Almost done... Rendering final frames" (near-complete)
  - "Complete! Loading preview..." (success)
- Estimated time remaining (based on model averages)
- Cancel generation button

#### `src/components/generation/video-preview.tsx`
- Video player for generated result
- Download button
- "Regenerate" and "Edit & Regenerate" actions
- "Use this video" → proceeds to publish flow

### 3.3 Updated Video Detail Page (`src/app/(app)/video/[id]/page.tsx`)

When a video has `status: "draft"` and no uploaded file (generated from prompt):
- Show the prompt + config summary
- "Generate" button triggers the Veo flow
- Show real-time generation progress

When a video has `status: "generating"`:
- Show generation progress overlay with polling status
- Show estimated time remaining
- Auto-update when Convex subscription detects status change to `ready`

When a video has `status: "ready"`:
- Show generated video in player
- Show AI-generated metadata (title, description, tags) from Gemini
- "Regenerate" button to try again with modified prompt
- Publish controls (existing flow)

### 3.4 Update AI Config Form (`src/components/video/ai-config-form.tsx`)

Currently a simple button. Upgrade to:

```tsx
// Pseudo-structure
<Card>
  <CardHeader>
    <CardTitle><Sparkles /> AI Video Generation</CardTitle>
  </CardHeader>
  <CardContent className="space-y-6">
    {/* Model Selection */}
    <ModelSelector value={model} onChange={setModel} />

    {/* Prompt */}
    <PromptEditor value={prompt} onChange={setPrompt} />

    {/* Quick Config */}
    <ConfigPanel config={config} onChange={setConfig} />

    {/* Advanced Settings (collapsible) */}
    <Collapsible>
      <AdvancedVeoSettings ... />
    </Collapsible>
  </CardContent>
  <CardFooter>
    <Button onClick={handleGenerate}>
      {isGenerating ? "Generating..." : "Generate Video"}
    </Button>
  </CardFooter>
</Card>
```

---

## Phase 4 — Frontend: Settings Page

### 4.1 AI Settings Page (`src/app/(app)/settings/ai/page.tsx`)

Currently a placeholder. Build full settings:

```
┌──────────────────────────────────────────────────────────────┐
│  AI Generation Defaults                                       │
│  These defaults apply to every new generation. Override per  │
│  video during generation.                                     │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Default Model                                                │
│  [Veo 3.1 Fast ▼]                                            │
│                                                               │
│  Default Resolution                                           │
│  [720p ▼]    ← highlighted as "Fastest & cheapest"           │
│                                                               │
│  Default Aspect Ratio                                         │
│  [16:9 ▼]                                                    │
│                                                               │
│  Default Duration                                             │
│  [8 seconds ───●──]                                          │
│                                                               │
│  Audio Generation                         [✓] Enabled       │
│  Prompt Enhancement                       [✓] Enabled       │
│  Person Generation                        [Don't allow ▼]   │
│                                                               │
│  ── Metadata Generation Defaults ──                          │
│                                                               │
│  Auto-generate metadata                   [✓] Enabled       │
│  Title                                    [✓] Auto-generate │
│  Description                              [✓] Auto-generate │
│  Tags                                     [✓] Auto-generate │
│  Tone                                     [Professional ▼]  │
│  Language                                 [English ▼]       │
│                                                               │
│  [                        Save Defaults                     ]  │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Settings Form Component (`src/components/settings/ai-defaults-form.tsx`)

Currently empty. Build with:
- All Veo model defaults
- All metadata generation defaults (existing fields from schema)
- Save button that calls `api.settings.update`
- Toast notification on save

---

## Phase 5 — Frontend: Dashboard & Navigation Updates

### 5.1 Add "Generate" Nav Item

Update `src/lib/constants.ts`:

```ts
export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: "LayoutDashboard" },
  { href: "/generate", label: "Generate", icon: "Sparkles" },        // NEW
  { href: "/upload", label: "Upload", icon: "Upload" },
  { href: "/drafts", label: "Drafts", icon: "Film" },
  { href: "/schedule", label: "Schedule", icon: "Calendar" },
  { href: "/history", label: "History", icon: "Clock" },
  { href: "/analytics", label: "Analytics", icon: "BarChart3" },
] as const;
```

### 5.2 Dashboard Updates (`src/app/(app)/dashboard/page.tsx`)

Add a "Quick Generate" card:
- Prominent CTA: "Generate Video with AI"
- Links to `/generate`
- Shows user's default model + resolution

### 5.3 Update Sidebar (`src/components/layout/sidebar.tsx`)

Add the new "Generate" nav item with Sparkles icon.

---

## Phase 6 — Dual-Flow Architecture

ReelCast now supports two creation paths:

### Path A: Upload → AI Metadata → Publish (existing)
```
Upload raw video → Gemini analyzes → AI metadata generated → Review → Publish
```

### Path B: Text Prompt → Veo Video → AI Metadata → Publish (new)
```
Write prompt → Veo generates video → Gemini generates metadata → Review → Publish
```

Both paths converge at the `video/[id]` detail page where:
- Generated/uploaded video plays in the player
- AI metadata is displayed and editable
- Publish controls are available

### Route Structure:
- `/generate` — New generation flow (prompt → Veo → video)
- `/upload` — Existing upload flow (file → Cloudinary → draft)
- `/video/[id]` — Shared detail page (both paths converge here)
- `/drafts` — Shows both uploaded and generated videos

---

## Phase 7 — Constants & Configuration Updates

### 7.1 Update `src/lib/constants.ts`

```ts
// ── Veo Model Configuration ──
export const VEO_MODELS = [
  {
    value: "veo-3.1-fast",
    label: "Veo 3.1 Fast",
    modelId: "veo-3.1-fast-generate-001",
    description: "Latest model with improved quality and audio generation",
    recommended: true,
    maxDuration: 8,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportsAudio: true,
  },
  {
    value: "veo-3-fast",
    label: "Veo 3 Fast",
    modelId: "veo-3.0-fast-generate-001",
    description: "Fast generation with audio. Proven quality.",
    recommended: false,
    maxDuration: 8,
    supportedResolutions: ["720p", "1080p"],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportsAudio: true,
  },
] as const;

export const VEO_RESOLUTIONS = [
  { value: "720p", label: "720p HD", description: "Fast & efficient", default: true },
  { value: "1080p", label: "1080p Full HD", description: "Higher quality" },
] as const;

export const VEO_ASPECT_RATIOS = [
  { value: "16:9", label: "16:9 Landscape", icon: "landscape", default: true },
  { value: "9:16", label: "9:16 Portrait", icon: "portrait" },
  { value: "1:1", label: "1:1 Square", icon: "square" },
] as const;

export const VEO_DURATIONS = [
  { value: 5, label: "5 seconds" },
  { value: 6, label: "6 seconds" },
  { value: 7, label: "7 seconds" },
  { value: 8, label: "8 seconds" },
] as const;

export const VEO_PERSON_GENERATION = [
  { value: "dont_allow", label: "Don't allow" },
  { value: "allow_adult", label: "Allow adult" },
] as const;

export const PROMPT_PRESETS = [
  { value: "cinematic", label: "Cinematic Landscape", prompt: "A sweeping cinematic shot of..." },
  { value: "product", label: "Product Showcase", prompt: "A professional product showcase video..." },
  { value: "tutorial", label: "Tutorial Intro", prompt: "An engaging intro for a tutorial video..." },
  { value: "social", label: "Social Media Clip", prompt: "A short, engaging social media clip..." },
  { value: "abstract", label: "Abstract Motion", prompt: "Abstract fluid motion with vibrant colors..." },
] as const;
```

### 7.2 Update Types

```ts
// src/types/video.ts — update AIConfig
export interface AIConfig {
  // Veo generation
  model?: string;
  prompt?: string;
  negativePrompt?: string;
  resolution?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  fps?: number;
  generateAudio?: boolean;
  enhancePrompt?: boolean;
  numberOfVideos?: number;
  personGeneration?: string;
  seed?: number;

  // Legacy
  preset?: string;
  quality?: string;
  captions?: boolean;
  backgroundMusic?: boolean;
}

// src/types/generation.ts — NEW
export interface GenerationConfig {
  model: string;
  prompt: string;
  negativePrompt?: string;
  resolution: string;
  aspectRatio: string;
  durationSeconds: number;
  generateAudio: boolean;
  enhancePrompt: boolean;
  personGeneration?: string;
}

export interface GenerationDefaults {
  model: string;
  resolution: string;
  aspectRatio: string;
  durationSeconds: number;
  generateAudio: boolean;
  enhancePrompt: boolean;
}
```

---

## Phase 8 — Environment Variables

### 8.1 No new env vars needed

The existing `GEMINI_API_KEY` in `.env.local` is used by `@google/genai` SDK for both Gemini text generation and Veo video generation. No additional keys required.

### 8.2 Update `.env.example`

```env
# ── Google AI ──────────────────────────────────────────
# Works for both Gemini (text/metadata) and Veo (video generation)
GEMINI_API_KEY=your_gemini_api_key_here
```

---

## Phase 9 — UX Polish & Animations

### 9.1 Generation States in CSS (`globals.css` additions)

```css
@keyframes veo-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 3, 53, 0.4); }
  50% { box-shadow: 0 0 0 12px rgba(255, 3, 53, 0); }
}

@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.generation-active {
  animation: veo-pulse 2s ease-in-out infinite;
}

.shimmer-loading {
  background: linear-gradient(
    90deg,
    var(--muted) 25%,
    var(--accent) 50%,
    var(--muted) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}
```

### 9.2 Model Selector UX

- Cards with radio selection, not dropdown
- Highlighted "Recommended" badge on Veo 3.1 Fast
- Subtle animation when switching models
- Description text updates on selection

### 9.3 Aspect Ratio Selector UX

- Visual mini-rectangles showing proportions (not just text)
- Selected state with primary border + fill
- Responsive grid layout

### 9.4 Duration Slider UX

- Custom styled slider with tick marks
- Shows "5s" to "8s" labels
- Current value displayed prominently
- Color gradient from green (5s) to yellow (8s) indicating cost/time

---

## Phase 10 — Scalability Considerations

### 10.1 Rate Limiting

- Convex action rate limiting: max 5 concurrent Veo generations per user
- Queue system: if user triggers multiple, they queue sequentially
- Global rate limit awareness: track Veo API quota

### 10.2 Error Handling

- Veo operation timeout (10 min max polling)
- Content filter rejection → show user-friendly message
- API key errors → admin notification
- Network errors → auto-retry up to 3 times

### 10.3 Cost Management

- Show estimated cost before generation ("This will use ~X credits")
- Track token/operation usage in `generations` table
- Usage dashboard in settings

### 10.4 Future Model Support

The architecture supports adding new models by:
1. Adding entry to `VEO_MODELS` constant
2. No backend code changes needed — the SDK `model` param is a string
3. UI auto-renders from the constant definition

---

## Implementation Order

1. **Schema updates** — Add Veo fields to `videos`, `settings`, new `generations` table
2. **`convex/lib/ai.ts`** — Veo client wrapper (submit + poll)
3. **`convex/actions/generation.ts`** — Start generation action
4. **`convex/scheduled/runGeneration.ts`** — Update to poll Veo
5. **Internal mutations** — `internalUpdateVeoOperation`, `internalUpdateProcessedFile`
6. **Constants** — `src/lib/constants.ts` Veo config
7. **Types** — Update `AIConfig`, add generation types
8. **`/generate` page** — New generation flow
9. **Generation components** — Model selector, prompt editor, config panel, progress
10. **Settings AI page** — Full Veo defaults form
11. **Video detail page** — Update to handle generated videos
12. **Dashboard** — Add quick generate CTA
13. **Navigation** — Add Generate nav item
14. **UX polish** — Animations, loading states, error states

---

## File Change Summary

### New Files
| File | Purpose |
|------|---------|
| `src/app/(app)/generate/page.tsx` | Veo generation page |
| `src/components/generation/model-selector.tsx` | Model picker UI |
| `src/components/generation/prompt-editor.tsx` | Prompt textarea with presets |
| `src/components/generation/config-panel.tsx` | Resolution, aspect ratio, duration controls |
| `src/components/generation/generation-progress.tsx` | Live progress indicator |
| `src/components/generation/video-preview.tsx` | Generated video player |
| `src/types/generation.ts` | Generation-specific types |
| `convex/actions/metadata.ts` | Gemini metadata generation from prompt |

### Modified Files
| File | Changes |
|------|---------|
| `convex/schema.ts` | Add Veo fields to videos/settings, add generations table |
| `convex/lib/ai.ts` | Full Veo client implementation (currently empty) |
| `convex/actions/generation.ts` | Veo submission action (currently empty) |
| `convex/scheduled/runGeneration.ts` | Add Veo polling, keep Gemini metadata for uploads |
| `convex/videos.ts` | Add internal mutations for Veo operation tracking |
| `convex/settings.ts` | Add Veo defaults to settings query/mutation, add getByVideoUserId |
| `src/lib/constants.ts` | Add Veo model/resolution/aspect ratio/prompt constants |
| `src/types/video.ts` | Update AIConfig interface with Veo fields |
| `src/types/settings.ts` | Add Veo defaults to UserSettings |
| `src/components/ai-config-form.tsx` | Upgrade to full Veo generation form |
| `src/components/metadata-editor.tsx` | Make editable with save functionality |
| `src/components/settings/ai-defaults-form.tsx` | Build full Veo defaults form |
| `src/app/(app)/video/[id]/page.tsx` | Handle generated video playback + generation states |
| `src/app/(app)/settings/ai/page.tsx` | Replace placeholder with full AI settings |
| `src/app/(app)/dashboard/page.tsx` | Add quick generate CTA |
| `src/app/globals.css` | Add Veo generation animations |
| `.env.example` | Add GEMINI_API_KEY comment |
