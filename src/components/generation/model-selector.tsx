"use client";

import { VEO_MODELS, type VeoModelKey } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Zap } from "lucide-react";

interface ModelSelectorProps {
  value: VeoModelKey;
  onChange: (value: VeoModelKey) => void;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Model</label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {VEO_MODELS.map((model) => (
          <button
            key={model.value}
            type="button"
            onClick={() => onChange(model.value)}
            className={cn(
              "relative flex flex-col items-start gap-1 rounded-lg border-2 p-4 text-left transition-all",
              value === model.value
                ? "border-primary bg-primary/5 shadow-sm"
                : "border-border hover:border-primary/40 hover:bg-muted/50"
            )}
          >
            {model.recommended && (
              <Badge className="absolute -top-2 right-3 text-[10px] px-2 py-0" variant="default">
                <Sparkles className="w-3 h-3 mr-1" />
                Recommended
              </Badge>
            )}
            <div className="flex items-center gap-2">
              <Zap className={cn("w-4 h-4", value === model.value ? "text-primary" : "text-muted-foreground")} />
              <span className="font-semibold text-sm">{model.label}</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {model.description}
            </p>
            <div className="flex gap-1 mt-1">
              <Badge variant="secondary" className="text-[10px]">{model.maxDuration}s max</Badge>
              {model.recommended && (
                <Badge variant="outline" className="text-[10px]">Developer API</Badge>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
