"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { UploadCloud, FileVideo, CheckCircle } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export default function UploadPage() {
  const router = useRouter();
  const createVideo = useMutation(api.videos.create);
  
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const simulateUpload = async (file: File) => {
    setUploading(true);
    setProgress(0);
    
    // Simulate chunked upload progress
    for (let i = 0; i <= 100; i += 10) {
      setProgress(i);
      await new Promise(r => setTimeout(r, 200));
    }
    
    // Simulate finishing
    const videoId = await createVideo({
      title: file.name.replace(/\.[^/.]+$/, ""), // remove extension
      rawFileKey: `mock_path_${Date.now()}_${file.name}`,
      rawFileSize: file.size,
    });
    
    router.push(`/video/${videoId}`);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      simulateUpload(file);
    } else {
      alert("Please drop a valid video file.");
    }
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      simulateUpload(file);
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Upload Footage</h1>
        <p className="text-muted-foreground">Drop your raw video here. We'll secure it and prepare it for AI generation.</p>
      </div>

      {!uploading ? (
        <Card 
          className={`border-2 border-dashed transition-colors ${
            isDragging ? "border-primary bg-primary/5" : "hover:border-primary/50"
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          <CardContent className="flex flex-col items-center justify-center p-16 text-center">
            <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-6">
              <UploadCloud className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Drag and drop your video</h3>
            <p className="text-muted-foreground mb-6">MP4, MOV, AVI up to 500MB</p>
            
            <label className="cursor-pointer">
              <span className="bg-primary text-primary-foreground px-4 py-2 rounded-md font-medium hover:bg-primary/90 transition-colors">
                Select File
              </span>
              <input 
                type="file" 
                accept="video/*" 
                className="hidden" 
                onChange={onFileSelect}
              />
            </label>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center p-16 text-center">
            <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-6">
              {progress < 100 ? (
                <FileVideo className="h-8 w-8 text-primary animate-pulse" />
              ) : (
                <CheckCircle className="h-8 w-8 text-success" />
              )}
            </div>
            <h3 className="text-xl font-semibold mb-6">
              {progress < 100 ? "Uploading your footage..." : "Upload complete!"}
            </h3>
            <div className="w-full max-w-md">
              <div className="flex justify-between text-sm mb-2 font-medium">
                <span>{progress < 100 ? "Processing chunks" : "Redirecting"}</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
