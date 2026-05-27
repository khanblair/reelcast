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

  const uploadFile = async (file: File) => {
    setUploading(true);
    setProgress(0);
    
    try {
      // 1. Get the signature and metadata from our endpoint
      const signRes = await fetch("/api/cloudinary/sign", {
        method: "POST",
      });
      if (!signRes.ok) {
        throw new Error("Failed to get Cloudinary upload signature");
      }
      const { signature, timestamp, apiKey, cloudName } = await signRes.json();

      // 2. Prepare FormData
      const formData = new FormData();
      formData.append("file", file);
      formData.append("signature", signature);
      formData.append("timestamp", timestamp.toString());
      formData.append("api_key", apiKey);

      // 3. Upload to Cloudinary using XMLHttpRequest for progress events
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, true);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percentComplete = Math.round((event.loaded / event.total) * 100);
          setProgress(percentComplete);
        }
      };

      const uploadPromise = new Promise<{ secure_url: string; bytes: number }>((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const response = JSON.parse(xhr.responseText);
              resolve(response);
            } catch {
              reject(new Error("Failed to parse Cloudinary response"));
            }
          } else {
            reject(new Error(`Upload failed with status: ${xhr.status} ${xhr.statusText}`));
          }
        };
        xhr.onerror = () => reject(new Error("Network error during Cloudinary upload"));
        xhr.onabort = () => reject(new Error("Upload aborted"));
      });

      xhr.send(formData);

      const cloudinaryData = await uploadPromise;
      
      // 4. Create the video entry in the Convex database
      const videoId = await createVideo({
        title: file.name.replace(/\.[^/.]+$/, ""), // remove extension
        rawFileKey: cloudinaryData.secure_url,
        rawFileSize: cloudinaryData.bytes || file.size,
      });
      
      router.push(`/video/${videoId}`);
    } catch (err: unknown) {
      console.error("Cloudinary upload failed:", err);
      const message = err instanceof Error ? err.message : "An error occurred during upload. Please try again.";
      alert(message);
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      uploadFile(file);
    } else {
      alert("Please drop a valid video file.");
    }
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      uploadFile(file);
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-4 sm:py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Upload Footage</h1>
        <p className="text-muted-foreground">Drop your raw video here. We&apos;ll secure it and prepare it for AI generation.</p>
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
          <CardContent className="flex flex-col items-center justify-center p-6 sm:p-16 text-center">
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
          <CardContent className="flex flex-col items-center justify-center p-6 sm:p-16 text-center">
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
