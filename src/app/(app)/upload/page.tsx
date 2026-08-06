"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { useMutation, useQuery, useAction } from "convex/react";
import {
  UploadCloud, FileVideo, CheckCircle, AlertCircle, X, Plus, FolderOpen,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

interface UploadItem {
  id: string;
  file: File;
  status: "waiting" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
  videoId?: Id<"videos">;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getVideoDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      const dur = isFinite(el.duration) ? Math.round(el.duration) : undefined;
      URL.revokeObjectURL(url);
      resolve(dur);
    };
    el.onerror = () => { URL.revokeObjectURL(url); resolve(undefined); };
    el.src = url;
  });
}

export default function UploadPage() {
  const createVideo      = useMutation(api.videos.create);
  const settings         = useQuery(api.settings.get);
  const generateMetadata = useAction(api.actions.metadata.generateForUpload);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  // Use a ref so the uploadOne closure always reads the latest settings value
  // without needing to be recreated every time settings loads.
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const updateItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((x) => x.id === id ? { ...x, ...patch } : x));
  }, []);

  const uploadOne = useCallback(async (item: UploadItem) => {
    updateItem(item.id, { status: "uploading", progress: 0 });
    try {
      const signRes = await fetch("/api/cloudinary/sign", { method: "POST" });
      if (!signRes.ok) throw new Error("Failed to get upload signature");
      const { signature, timestamp, apiKey, cloudName } = await signRes.json();

      const formData = new FormData();
      formData.append("file", item.file);
      formData.append("signature", signature);
      formData.append("timestamp", timestamp.toString());
      formData.append("api_key", apiKey);

      const cloudinaryData = await new Promise<{ secure_url: string; bytes: number }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, true);
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              updateItem(item.id, { progress: Math.round((e.loaded / e.total) * 100) });
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch {
                reject(new Error("Failed to parse upload response"));
              }
            } else {
              reject(new Error(`Upload failed: ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error("Network error during upload"));
          xhr.onabort = () => reject(new Error("Upload aborted"));
          xhr.send(formData);
        }
      );

      const duration = await getVideoDuration(item.file);
      const videoId = await createVideo({
        title: item.file.name.replace(/\.[^/.]+$/, ""),
        rawFileKey: cloudinaryData.secure_url,
        rawFileSize: cloudinaryData.bytes || item.file.size,
        duration,
      });

      updateItem(item.id, {
        status: "done",
        progress: 100,
        videoId: videoId as Id<"videos">,
      });

      // Auto-generate metadata if the user has it enabled
      if (settingsRef.current?.aiAutoGenerate) {
        try {
          await generateMetadata({ videoId: videoId as Id<"videos"> });
        } catch (e) {
          // Non-critical: log but don't fail the upload
          console.warn("Auto-generate metadata failed:", e);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      updateItem(item.id, { status: "error", error: message });
    }
  }, [createVideo, updateItem, generateMetadata]);

  const addFilesAndUpload = useCallback(async (files: FileList | File[]) => {
    const videoFiles = Array.from(files).filter((f) => f.type.startsWith("video/"));
    if (videoFiles.length === 0) return;

    const newItems: UploadItem[] = videoFiles.map((file, i) => ({
      id: `${Date.now()}-${i}`,
      file,
      status: "waiting" as const,
      progress: 0,
    }));

    setItems((prev) => [...prev, ...newItems]);

    // Upload sequentially
    for (const item of newItems) {
      await uploadOne(item);
    }
  }, [uploadOne]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    addFilesAndUpload(e.dataTransfer.files);
  }, [addFilesAndUpload]);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addFilesAndUpload(e.target.files);
      e.target.value = "";
    }
  }, [addFilesAndUpload]);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const allDone = items.length > 0 && items.every((x) => x.status === "done" || x.status === "error");
  const anyUploading = items.some((x) => x.status === "uploading" || x.status === "waiting");
  const doneCount = items.filter((x) => x.status === "done").length;
  const errorCount = items.filter((x) => x.status === "error").length;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Upload Footage</h1>
        <p className="text-muted-foreground">
          Drop one or more videos here. We&apos;ll store them and prepare them for AI generation or direct publishing.
        </p>
      </div>

      {/* Drop zone */}
      <Card
        className={`border-2 border-dashed transition-colors cursor-pointer ${
          isDragging
            ? "border-primary bg-primary/5"
            : anyUploading
            ? "border-muted opacity-60 cursor-not-allowed"
            : "hover:border-primary/50"
        }`}
        onDragOver={(e) => { e.preventDefault(); if (!anyUploading) setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={anyUploading ? undefined : onDrop}
        onClick={() => !anyUploading && fileInputRef.current?.click()}
      >
        <CardContent className="flex flex-col items-center justify-center p-8 sm:p-12 text-center">
          <div className={`w-14 h-14 rounded-full bg-secondary flex items-center justify-center mb-4 ${
            isDragging ? "scale-110" : ""
          } transition-transform`}>
            <UploadCloud className="h-7 w-7 text-primary" />
          </div>
          <h3 className="text-lg font-semibold mb-1">
            {items.length > 0 ? "Drop more videos to add" : "Drag and drop your videos"}
          </h3>
          <p className="text-muted-foreground text-sm mb-4">
            MP4, MOV, AVI up to 500MB each, select multiple files at once
          </p>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-2 rounded-md font-medium text-sm hover:bg-primary/90 transition-colors">
              <Plus className="h-4 w-4" />
              {items.length > 0 ? "Add More Files" : "Select Files"}
            </span>
          </div>
        </CardContent>
      </Card>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        multiple
        className="hidden"
        onChange={onFileSelect}
      />

      {/* File list */}
      {items.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              {anyUploading
                ? `Uploading ${items.filter((x) => x.status === "uploading").length > 0
                    ? `"${items.find((x) => x.status === "uploading")?.file.name}"…`
                    : "…"
                  }`
                : allDone
                ? `${doneCount} uploaded${errorCount > 0 ? `, ${errorCount} failed` : ""}`
                : `${items.length} file${items.length !== 1 ? "s" : ""} queued`}
            </h2>
            {!anyUploading && (
              <button
                type="button"
                onClick={() => setItems([])}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear all
              </button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {items.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 p-3">
                    {/* Status icon */}
                    <div className="shrink-0">
                      {item.status === "done" ? (
                        <CheckCircle className="h-5 w-5 text-emerald-500" />
                      ) : item.status === "error" ? (
                        <AlertCircle className="h-5 w-5 text-destructive" />
                      ) : item.status === "uploading" ? (
                        <FileVideo className="h-5 w-5 text-primary animate-pulse" />
                      ) : (
                        <FileVideo className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>

                    {/* File info + progress */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <span className="text-sm font-medium truncate">{item.file.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatBytes(item.file.size)}
                        </span>
                      </div>

                      {item.status === "uploading" && (
                        <div className="space-y-0.5">
                          <Progress value={item.progress} className="h-1.5" />
                          <p className="text-xs text-muted-foreground">{item.progress}%</p>
                        </div>
                      )}
                      {item.status === "waiting" && (
                        <p className="text-xs text-muted-foreground">Waiting…</p>
                      )}
                      {item.status === "error" && (
                        <p className="text-xs text-destructive">{item.error}</p>
                      )}
                      {item.status === "done" && (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400">
                          Uploaded successfully
                        </p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="shrink-0 flex items-center gap-1.5">
                      {item.status === "done" && item.videoId && (
                        <Link href={`/video/${item.videoId}`}>
                          <Button variant="ghost" size="sm" className="h-7 text-xs">
                            View
                          </Button>
                        </Link>
                      )}
                      {(item.status === "done" || item.status === "error") && (
                        <button
                          type="button"
                          onClick={() => removeItem(item.id)}
                          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Post-upload actions */}
          {allDone && (
            <div className="flex items-center gap-3 pt-1">
              {doneCount > 0 && (
                <Link href="/drafts">
                  <Button>
                    <FolderOpen className="mr-2 h-4 w-4" />
                    Go to Library ({doneCount} new video{doneCount !== 1 ? "s" : ""})
                  </Button>
                </Link>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  setItems([]);
                  setTimeout(() => fileInputRef.current?.click(), 50);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Upload More
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
