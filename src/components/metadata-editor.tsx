"use client";

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import type { Video as VideoType } from "@/types/video";

export function MetadataEditor({ video }: { video: VideoType }) {
  // Normally this would have form state to save edits, 
  // but for the mockup we'll just display the AI generated data or defaults.
  
  const title = video.aiTitle || video.title;
  const description = video.aiDescription || "No description generated yet.";
  const tags = video.aiTags || video.tags || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Video Details</CardTitle>
        <CardDescription>Review and edit the AI generated metadata.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            Title
            {video.aiTitle && <Sparkles className="h-3 w-3 text-primary" />}
          </Label>
          <Input key={video.aiTitle ?? "no-ai"} defaultValue={title} />
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            Description
            {video.aiDescription && <Sparkles className="h-3 w-3 text-primary" />}
          </Label>
          <Textarea key={video.aiDescription ?? "no-ai"} rows={6} defaultValue={description} />
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            Tags
            {video.aiTags && video.aiTags.length > 0 && <Sparkles className="h-3 w-3 text-primary" />}
          </Label>
          <div className="flex flex-wrap gap-2 p-3 border rounded-md min-h-[42px]">
            {tags.length > 0 ? (
              tags.map(tag => (
                <Badge key={tag} variant="secondary">{tag}</Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">No tags</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
