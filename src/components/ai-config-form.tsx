"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Sparkles } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AI_PRESETS, OUTPUT_QUALITY, ASPECT_RATIOS } from "@/lib/constants";
import { Id } from "../../convex/_generated/dataModel";

export function AIConfigForm({ videoId }: { videoId: Id<"videos"> }) {
  const triggerGeneration = useMutation(api.jobs.create);
  const updateStatus = useMutation(api.videos.updateStatus);
  const [loading, setLoading] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      // Create a background job
      await triggerGeneration({ videoId, type: "generation" });
      // Update video status
      await updateStatus({ id: videoId, status: "queued" });
    } catch (e) {
      console.error(e);
      alert("Failed to queue generation job");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          AI Generation Config
        </CardTitle>
        <CardDescription>
          Configure how the AI will analyze and process your video.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label>Style Preset</Label>
          <Select defaultValue={AI_PRESETS[0].value}>
            {AI_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Quality</Label>
            <Select defaultValue={OUTPUT_QUALITY[1].value}>
              {OUTPUT_QUALITY.map((q) => (
                <option key={q.value} value={q.value}>{q.label}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Aspect Ratio</Label>
            <Select defaultValue={ASPECT_RATIOS[0].value}>
              {ASPECT_RATIOS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>Generate Captions</Label>
            <p className="text-sm text-muted-foreground">Auto-generate burned in captions</p>
          </div>
          <Switch defaultChecked />
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={handleGenerate} disabled={loading} className="w-full font-semibold">
          {loading ? "Queueing..." : "Start AI Generation"}
        </Button>
      </CardFooter>
    </Card>
  );
}
