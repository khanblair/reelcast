"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Sparkles, Loader2 } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Id } from "../../convex/_generated/dataModel";

export function AIConfigForm({ videoId, status }: { videoId: Id<"videos">; status: string }) {
  const triggerGeneration = useMutation(api.jobs.create);
  const updateStatus = useMutation(api.videos.updateStatus);
  const [loading, setLoading] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      await updateStatus({ id: videoId, status: "queued" });
      await triggerGeneration({ videoId, type: "generation" });
    } catch (e) {
      console.error(e);
      alert("Failed to queue generation job");
    } finally {
      setLoading(false);
    }
  };

  const isGenerating = status === "queued" || status === "generating";
  const isFailed = status === "failed";
  const isDone = status === "ready" || status === "published" || status === "publishing" || status === "scheduled";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          AI Metadata Generator
        </CardTitle>
        <CardDescription>
          Generate an engaging title, description, and tags for your video using AI.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isGenerating && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing your video and generating metadata...
          </div>
        )}
        {isFailed && (
          <p className="text-sm text-destructive">
            Last generation attempt failed. Try again.
          </p>
        )}
        {isDone && (
          <p className="text-sm text-muted-foreground">
            Metadata has been generated. You can regenerate if needed.
          </p>
        )}
        {status === "draft" && (
          <p className="text-sm text-muted-foreground">
            Click below to have AI analyze your video and generate an optimized title, description, and SEO tags.
          </p>
        )}
      </CardContent>
      <CardFooter>
        <Button
          onClick={handleGenerate}
          disabled={loading || isGenerating}
          className="w-full font-semibold"
        >
          {loading || isGenerating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {loading ? "Queueing..." : "Generating..."}
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {isFailed ? "Retry AI Generation" : isDone ? "Regenerate Metadata" : "Generate Title, Description & Tags"}
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
}
