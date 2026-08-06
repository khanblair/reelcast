"use client";

import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { PROMPT_PRESETS } from "@/lib/constants";
import { ChevronDown, ChevronUp, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

interface PromptEditorProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  negativePrompt: string;
  onNegativePromptChange: (value: string) => void;
}

const MAX_PROMPT_LENGTH = 2000;

export function PromptEditor({
  prompt,
  onPromptChange,
  negativePrompt,
  onNegativePromptChange,
}: PromptEditorProps) {
  const [showPresets, setShowPresets] = useState(false);
  const [showNegative, setShowNegative] = useState(false);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Prompt</Label>
          <span
            className={cn(
              "text-xs",
              prompt.length > MAX_PROMPT_LENGTH * 0.9
                ? "text-destructive"
                : "text-muted-foreground"
            )}
          >
            {prompt.length}/{MAX_PROMPT_LENGTH}
          </span>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => {
            if (e.target.value.length <= MAX_PROMPT_LENGTH) {
              onPromptChange(e.target.value);
            }
          }}
          placeholder="Describe your video in detail. Be specific about scenes, actions, lighting, camera angles, and mood..."
          rows={4}
          className="resize-none"
        />
        <p className="text-xs text-muted-foreground">
          Be descriptive, include scenes, actions, style, lighting, and camera movement.
        </p>
      </div>

      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs h-7 px-2"
          onClick={() => setShowPresets(!showPresets)}
        >
          <Lightbulb className="w-3 h-3 mr-1" />
          Prompt presets
          {showPresets ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
        </Button>
        {showPresets && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2 animate-slide-down">
            {PROMPT_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => onPromptChange(preset.prompt)}
                className={cn(
                  "text-left rounded-md border px-3 py-2 text-xs transition-colors",
                  "hover:bg-primary/5 hover:border-primary/40",
                  prompt === preset.prompt
                    ? "border-primary bg-primary/5"
                    : "border-border"
                )}
              >
                <span className="font-medium">{preset.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs h-7 px-2"
          onClick={() => setShowNegative(!showNegative)}
        >
          Negative prompt (optional)
          {showNegative ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
        </Button>
        {showNegative && (
          <div className="mt-2 animate-slide-down">
            <Input
              value={negativePrompt}
              onChange={(e) => onNegativePromptChange(e.target.value)}
              placeholder="What to avoid in the video (e.g., blurry, low quality, text overlay)"
            />
          </div>
        )}
      </div>
    </div>
  );
}
