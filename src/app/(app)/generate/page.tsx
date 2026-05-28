"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Sparkles, Loader2, Video, ArrowRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/generation/model-selector";
import { PromptEditor } from "@/components/generation/prompt-editor";
import { ConfigPanel } from "@/components/generation/config-panel";
import { GenerationProgress } from "@/components/generation/generation-progress";
import { VEO_DEFAULTS, type VeoModelKey } from "@/lib/constants";

export default function GeneratePage() {
  const router = useRouter();
  const settings = useQuery(api.settings.get);
  const createGenerated = useMutation(api.videos.createGenerated);
  const updateStatus = useMutation(api.videos.updateStatus);
  const triggerJob = useMutation(api.jobs.create);

  const [model, setModel] = useState<VeoModelKey>(
    (settings?.veoModel as VeoModelKey) ?? VEO_DEFAULTS.model
  );
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [resolution, setResolution] = useState(
    settings?.veoResolution ?? VEO_DEFAULTS.resolution
  );
  const [aspectRatio, setAspectRatio] = useState(
    settings?.veoAspectRatio ?? VEO_DEFAULTS.aspectRatio
  );
  const [durationSeconds, setDurationSeconds] = useState(
    settings?.veoDurationSeconds ?? VEO_DEFAULTS.durationSeconds
  );
  const [enhancePrompt, setEnhancePrompt] = useState(
    settings?.veoEnhancePrompt ?? VEO_DEFAULTS.enhancePrompt
  );

  const [submitting, setSubmitting] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<
    "idle" | "queued" | "generating" | "ready" | "failed"
  >("idle");
  const [generatedVideoId, setGeneratedVideoId] = useState<string | null>(null);

  const canGenerate = prompt.trim().length >= 10 && !submitting;

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setSubmitting(true);
    setGenerationStatus("queued");

    try {
      const videoId = await createGenerated({
        title: prompt.slice(0, 80),
        aiConfig: {
          model,
          prompt,
          negativePrompt: negativePrompt || undefined,
          resolution,
          aspectRatio,
          durationSeconds,
          enhancePrompt,
        },
      });

      setGeneratedVideoId(videoId);
      await updateStatus({ id: videoId, status: "queued" });
      await triggerJob({ videoId, type: "generation" });
      setGenerationStatus("generating");

      router.push(`/video/${videoId}`);
    } catch (err) {
      console.error("Generation failed:", err);
      setGenerationStatus("failed");
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2 flex items-center gap-2">
          <Sparkles className="h-7 w-7 text-primary" />
          Generate Video with AI
        </h1>
        <p className="text-muted-foreground">
          Create stunning videos from text prompts using Veo. Describe your vision and let AI bring it to life.
        </p>
      </div>

      {generationStatus === "idle" || generationStatus === "failed" ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Model</CardTitle>
              <CardDescription>Choose the AI model for video generation</CardDescription>
            </CardHeader>
            <CardContent>
              <ModelSelector value={model} onChange={setModel} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Video className="h-5 w-5" />
                Prompt
              </CardTitle>
              <CardDescription>Describe the video you want to create</CardDescription>
            </CardHeader>
            <CardContent>
              <PromptEditor
                prompt={prompt}
                onPromptChange={setPrompt}
                negativePrompt={negativePrompt}
                onNegativePromptChange={setNegativePrompt}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Configuration</CardTitle>
              <CardDescription>Fine-tune your generation settings</CardDescription>
            </CardHeader>
            <CardContent>
              <ConfigPanel
                resolution={resolution}
                onResolutionChange={setResolution}
                aspectRatio={aspectRatio}
                onAspectRatioChange={setAspectRatio}
                durationSeconds={durationSeconds}
                onDurationSecondsChange={setDurationSeconds}
                enhancePrompt={enhancePrompt}
                onEnhancePromptChange={setEnhancePrompt}
              />
            </CardContent>
            <CardFooter className="border-t pt-6">
              <Button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="w-full font-semibold h-12 text-base"
                size="lg"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Submitting to Veo...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-5 w-5" />
                    Generate Video
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
            </CardFooter>
          </Card>

          {prompt.trim().length > 0 && prompt.trim().length < 10 && (
            <p className="text-sm text-destructive text-center">
              Prompt must be at least 10 characters ({prompt.trim().length}/10)
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Generation Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Model:</span>{" "}
                  <span className="font-medium capitalize">{model.replace(/-/g, " ")}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Resolution:</span>{" "}
                  <span className="font-medium">{resolution}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Aspect Ratio:</span>{" "}
                  <span className="font-medium">{aspectRatio}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Duration:</span>{" "}
                  <span className="font-medium">{durationSeconds}s</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Enhance Prompt:</span>{" "}
                  <span className="font-medium">{enhancePrompt ? "Yes" : "No"}</span>
                </div>
              </div>
              <div className="pt-2 border-t">
                <span className="text-muted-foreground text-sm">Prompt:</span>
                <p className="text-sm mt-1">{prompt}</p>
              </div>
            </CardContent>
          </Card>

          <GenerationProgress status={generationStatus} />

          {generatedVideoId && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => router.push(`/video/${generatedVideoId}`)}
            >
              View Video Details
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
