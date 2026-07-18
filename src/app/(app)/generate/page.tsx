"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Sparkles, Loader2, Video, ArrowRight, Wand2, CheckSquare, Square, CheckCircle, AlertCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ModelSelector } from "@/components/generation/model-selector";
import { PromptEditor } from "@/components/generation/prompt-editor";
import { ConfigPanel } from "@/components/generation/config-panel";
import { GenerationProgress } from "@/components/generation/generation-progress";
import { VEO_DEFAULTS, VEO_MODELS, type VeoModelKey } from "@/lib/constants";

export default function GeneratePage() {
  const router = useRouter();
  const settings = useQuery(api.settings.get);
  const createGenerated = useMutation(api.videos.createGenerated);
  const updateStatus = useMutation(api.videos.updateStatus);
  const triggerJob = useMutation(api.jobs.create);

  // --- Video generation state ---
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
  const [generateAudio, setGenerateAudio] = useState<boolean>(VEO_DEFAULTS.generateAudio);

  const selectedModelDef = VEO_MODELS.find((m) => m.value === model);
  const modelSupportsAudio = selectedModelDef?.supportsAudio ?? false;

  const [submitting, setSubmitting] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<
    "idle" | "queued" | "generating" | "ready" | "failed"
  >("idle");
  const [generatedVideoId, setGeneratedVideoId] = useState<string | null>(null);

  const canGenerate = prompt.trim().length >= 10 && !submitting;

  // --- Tab state ---
  const [activeTab, setActiveTab] = useState<"video" | "metadata">("video");

  // --- Metadata tab state ---
  const allVideos = useQuery(api.videos.list);
  const generateForUpload = useAction(api.actions.metadata.generateForUpload);

  const [metaSearch, setMetaSearch] = useState("");
  const [metaSelected, setMetaSelected] = useState<Set<string>>(new Set());
  const [metaResults, setMetaResults] = useState<Map<string, { title: string } | { error: string }>>(new Map());
  const [metaProgress, setMetaProgress] = useState<{ done: number; total: number } | null>(null);
  const [metaRunning, setMetaRunning] = useState(false);
  const [readySelected, setReadySelected] = useState<Set<string>>(new Set());
  const [markingReady, setMarkingReady] = useState(false);

  // --- Computed values ---
  const filteredMetaVideos = useMemo(() => {
    const list = allVideos ?? [];
    if (!metaSearch.trim()) return list;
    const q = metaSearch.toLowerCase();
    return list.filter(v => ((v as any).aiTitle ?? v.title).toLowerCase().includes(q));
  }, [allVideos, metaSearch]);

  const videosWithMeta = useMemo(() =>
    [...metaResults.entries()].filter(([, r]) => "title" in r).map(([id]) => id),
    [metaResults]
  );

  // --- Handlers ---
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
          generateAudio: modelSupportsAudio ? generateAudio : undefined,
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

  const toggleMetaVideo = useCallback((id: string) => {
    setMetaSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleGenerateMetadata = async () => {
    if (metaSelected.size === 0 || metaRunning) return;
    const ids = [...metaSelected];
    setMetaRunning(true);
    setMetaProgress({ done: 0, total: ids.length });
    setMetaResults(new Map());

    const resultsAccumulated = new Map<string, { title: string } | { error: string }>();

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        const result = await generateForUpload({ videoId: id as Id<"videos"> });
        resultsAccumulated.set(id, { title: result.title });
        setMetaResults(new Map(resultsAccumulated));
      } catch (e) {
        resultsAccumulated.set(id, { error: e instanceof Error ? e.message : "Failed" });
        setMetaResults(new Map(resultsAccumulated));
      }
      setMetaProgress({ done: i + 1, total: ids.length });
    }

    // Auto-select successful ones for "mark as ready"
    setReadySelected(new Set(
      ids.filter(id => { const r = resultsAccumulated.get(id); return r !== undefined && "title" in r; })
    ));
    setMetaRunning(false);
  };

  const handleMarkReady = async () => {
    if (readySelected.size === 0 || markingReady) return;
    setMarkingReady(true);
    try {
      for (const id of readySelected) {
        await updateStatus({ id: id as Id<"videos">, status: "ready" });
      }
      setReadySelected(new Set());
      setMetaSelected(new Set());
      setMetaResults(new Map());
      setMetaProgress(null);
    } finally {
      setMarkingReady(false);
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

      {/* Tab switcher */}
      <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setActiveTab("video")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            activeTab === "video"
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" /> Generate Video
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("metadata")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            activeTab === "metadata"
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Wand2 className="h-3.5 w-3.5" /> Generate Metadata
        </button>
      </div>

      {activeTab === "video" && (
        <>
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
                    generateAudio={generateAudio}
                    onGenerateAudioChange={setGenerateAudio}
                    modelSupportsAudio={modelSupportsAudio}
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
        </>
      )}

      {activeTab === "metadata" && (
        <div className="space-y-6">
          <p className="text-muted-foreground text-sm">
            Select videos from your library to auto-generate YouTube titles, descriptions, and tags.
          </p>

          {/* Video selection */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-lg">Your Library</CardTitle>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setMetaSelected(new Set((allVideos ?? []).map(v => v._id)))}
                  >
                    Select all
                  </button>
                  <span className="text-muted-foreground text-xs">·</span>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:underline"
                    onClick={() => setMetaSelected(new Set())}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <input
                type="text"
                placeholder="Search videos…"
                value={metaSearch}
                onChange={e => setMetaSearch(e.target.value)}
                className="mt-2 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-64 overflow-y-auto divide-y divide-border">
                {filteredMetaVideos.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-center text-muted-foreground">No videos found.</p>
                ) : (
                  filteredMetaVideos.map(v => (
                    <button
                      key={v._id}
                      type="button"
                      onClick={() => toggleMetaVideo(v._id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
                    >
                      {metaSelected.has(v._id)
                        ? <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                        : <Square className="h-4 w-4 text-muted-foreground shrink-0" />
                      }
                      <span className="text-sm truncate flex-1">{(v as any).aiTitle ?? v.title}</span>
                      <span className="text-xs text-muted-foreground capitalize shrink-0">{v.status}</span>
                      {metaResults.has(v._id) && (
                        "title" in metaResults.get(v._id)!
                          ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                          : <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </CardContent>
            <CardFooter className="border-t pt-4 pb-4 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                {metaSelected.size} video{metaSelected.size !== 1 ? "s" : ""} selected
              </span>
            </CardFooter>
          </Card>

          {/* Generate button */}
          <Button
            onClick={handleGenerateMetadata}
            disabled={metaSelected.size === 0 || metaRunning}
            className="w-full font-semibold h-12 text-base"
            size="lg"
          >
            {metaRunning ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Processing {metaProgress?.done ?? 0}/{metaProgress?.total ?? 0}…
              </>
            ) : (
              <>
                <Wand2 className="mr-2 h-5 w-5" />
                Generate Metadata for {metaSelected.size} Video{metaSelected.size !== 1 ? "s" : ""}
              </>
            )}
          </Button>

          {/* Results */}
          {metaResults.size > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Results</CardTitle>
                <CardDescription>
                  Select which to mark as Ready for publishing
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {[...metaResults.entries()].map(([id, result]) => {
                  const video = (allVideos ?? []).find(v => v._id === id);
                  const label = video ? ((video as any).aiTitle ?? video.title) : id;
                  if ("title" in result) {
                    return (
                      <div key={id} className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() => setReadySelected(prev => {
                            const next = new Set(prev);
                            if (next.has(id)) next.delete(id); else next.add(id);
                            return next;
                          })}
                          className="flex items-center gap-2 text-left flex-1 hover:bg-muted/50 rounded px-2 py-1 transition-colors"
                        >
                          {readySelected.has(id)
                            ? <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                            : <Square className="h-4 w-4 text-muted-foreground shrink-0" />
                          }
                          <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />
                          <span className="text-sm">
                            <span className="text-muted-foreground truncate">{label}</span>
                            {" → "}
                            <span className="font-medium">"{result.title}"</span>
                          </span>
                        </button>
                      </div>
                    );
                  } else {
                    return (
                      <div key={id} className="flex items-center gap-2 px-2 py-1">
                        <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                        <span className="text-sm text-muted-foreground truncate">{label}</span>
                        <span className="text-sm text-destructive">{result.error}</span>
                      </div>
                    );
                  }
                })}
              </CardContent>
              <CardFooter className="border-t pt-4 flex flex-col gap-3 items-stretch">
                <Button
                  onClick={handleMarkReady}
                  disabled={readySelected.size === 0 || markingReady}
                  className="w-full"
                >
                  {markingReady ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Marking as Ready…
                    </>
                  ) : (
                    <>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Mark {readySelected.size} Video{readySelected.size !== 1 ? "s" : ""} as Ready
                    </>
                  )}
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  Ready videos can be scheduled or published directly from the Schedule page or Library.
                </p>
              </CardFooter>
            </Card>
          )}

          {/* Hidden usage to suppress unused warning */}
          {videosWithMeta.length > 0 && null}
        </div>
      )}
    </div>
  );
}
