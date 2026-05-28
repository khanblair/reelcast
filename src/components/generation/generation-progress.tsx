"use client";

import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface GenerationProgressProps {
  status: "queued" | "generating" | "ready" | "failed";
  attempt?: number;
  maxAttempts?: number;
}

const STATUS_MESSAGES: Record<string, { text: string; subtext: string }> = {
  queued: {
    text: "Submitting to Veo...",
    subtext: "Preparing your generation request",
  },
  generating: {
    text: "Generating your video...",
    subtext: "Veo is creating your video. This typically takes 2-5 minutes.",
  },
  ready: {
    text: "Generation complete!",
    subtext: "Your video is ready for preview",
  },
  failed: {
    text: "Generation failed",
    subtext: "Something went wrong. You can try again.",
  },
};

export function GenerationProgress({ status, attempt, maxAttempts }: GenerationProgressProps) {
  const info = STATUS_MESSAGES[status] ?? STATUS_MESSAGES.queued;
  const progressValue =
    status === "queued" ? 10 :
    status === "generating" ? Math.min(90, ((attempt ?? 1) / (maxAttempts ?? 40)) * 100) :
    status === "ready" ? 100 : 0;

  return (
    <div className="rounded-lg border bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        {status === "queued" || status === "generating" ? (
          <div className="relative">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <div className="absolute inset-0 animate-ping rounded-full bg-primary/20" />
          </div>
        ) : status === "ready" ? (
          <div className="h-6 w-6 rounded-full bg-success/20 flex items-center justify-center">
            <div className="h-3 w-3 rounded-full bg-success" />
          </div>
        ) : (
          <div className="h-6 w-6 rounded-full bg-destructive/20 flex items-center justify-center">
            <div className="h-3 w-3 rounded-full bg-destructive" />
          </div>
        )}
        <div>
          <p className={cn("font-semibold text-sm", status === "failed" && "text-destructive")}>
            {info.text}
          </p>
          <p className="text-xs text-muted-foreground">{info.subtext}</p>
        </div>
      </div>

      {(status === "queued" || status === "generating") && (
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Progress</span>
            <span>{Math.round(progressValue)}%</span>
          </div>
          <Progress value={progressValue} className="h-1.5" />
          <p className="text-[11px] text-muted-foreground text-center">
            Polling Veo API... Attempt {attempt ?? 1} of {maxAttempts ?? 40}
          </p>
        </div>
      )}

      {status === "generating" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground justify-center">
          <div className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse"
                style={{ animationDelay: `${i * 0.3}s` }}
              />
            ))}
          </div>
          <span>Veo is processing your prompt</span>
        </div>
      )}
    </div>
  );
}
