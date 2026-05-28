"use client";

import { VEO_RESOLUTIONS, VEO_ASPECT_RATIOS, VEO_DURATIONS } from "@/lib/constants";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface ConfigPanelProps {
  resolution: string;
  onResolutionChange: (value: string) => void;
  aspectRatio: string;
  onAspectRatioChange: (value: string) => void;
  durationSeconds: number;
  onDurationSecondsChange: (value: number) => void;
  enhancePrompt: boolean;
  onEnhancePromptChange: (value: boolean) => void;
  generateAudio?: boolean;
  onGenerateAudioChange?: (value: boolean) => void;
  modelSupportsAudio?: boolean;
}

const ASPECT_PREVIEWS: Record<string, string> = {
  "16:9": "w-12 h-7",
  "9:16": "w-5 h-8",
  "1:1":  "w-8 h-8",
};

export function ConfigPanel({
  resolution,
  onResolutionChange,
  aspectRatio,
  onAspectRatioChange,
  durationSeconds,
  onDurationSecondsChange,
  enhancePrompt,
  onEnhancePromptChange,
  generateAudio,
  onGenerateAudioChange,
  modelSupportsAudio,
}: ConfigPanelProps) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        {/* Resolution */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Resolution</Label>
          <div className="flex gap-2">
            {VEO_RESOLUTIONS.map((res) => (
              <button
                key={res.value}
                type="button"
                onClick={() => onResolutionChange(res.value)}
                className={cn(
                  "flex-1 rounded-md border px-3 py-2 text-sm transition-all",
                  resolution === res.value
                    ? "border-primary bg-primary/5 font-medium"
                    : "border-border hover:border-primary/40"
                )}
              >
                <div>{res.label}</div>
                {res.default && resolution === res.value && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">Default</div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Duration */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Duration</Label>
          <div className="flex gap-1.5">
            {VEO_DURATIONS.map((dur) => (
              <button
                key={dur.value}
                type="button"
                onClick={() => onDurationSecondsChange(dur.value)}
                className={cn(
                  "flex-1 rounded-md border px-2 py-2 text-sm transition-all",
                  durationSeconds === dur.value
                    ? "border-primary bg-primary/5 font-medium"
                    : "border-border hover:border-primary/40"
                )}
              >
                {dur.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Aspect Ratio */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Aspect Ratio</Label>
        <div className="flex gap-3">
          {VEO_ASPECT_RATIOS.map((ar) => {
            const preview = ASPECT_PREVIEWS[ar.value] ?? "w-8 h-8";
            return (
              <button
                key={ar.value}
                type="button"
                onClick={() => onAspectRatioChange(ar.value)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-lg border-2 px-4 py-3 transition-all flex-1",
                  aspectRatio === ar.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                )}
              >
                <div
                  className={cn(
                    "rounded-sm border-2 transition-colors",
                    preview,
                    aspectRatio === ar.value ? "border-primary" : "border-muted-foreground/40"
                  )}
                />
                <span className="text-xs font-medium">{ar.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {/* Enhance Prompt */}
        <div className="flex items-center justify-between rounded-lg border p-3 flex-1 min-w-[180px]">
          <div>
            <Label className="text-sm font-medium">Enhance Prompt</Label>
            <p className="text-[11px] text-muted-foreground">Let AI improve your prompt</p>
          </div>
          <Switch checked={enhancePrompt} onCheckedChange={onEnhancePromptChange} />
        </div>

        {/* Generate Audio — only for Veo 3 models via Vertex AI */}
        {modelSupportsAudio && onGenerateAudioChange && (
          <div className="flex items-center justify-between rounded-lg border p-3 flex-1 min-w-[180px]">
            <div>
              <Label className="text-sm font-medium">Generate Audio</Label>
              <p className="text-[11px] text-muted-foreground">Add sound to your video</p>
            </div>
            <Switch checked={generateAudio ?? true} onCheckedChange={onGenerateAudioChange} />
          </div>
        )}
      </div>
    </div>
  );
}
