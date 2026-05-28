import Link from "next/link";
import Image from "next/image";
import { formatDistanceToNow } from "date-fns";
import { Video, Youtube } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { VideoStatusBadge } from "./video-status-badge";
import type { Video as VideoType } from "@/types/video";

interface VideoCardProps {
  video: VideoType;
}

export function VideoCard({ video }: VideoCardProps) {
  const timeAgo = formatDistanceToNow(video._creationTime, { addSuffix: true });
  const youtubeUrl = video.publishedVideoId
    ? `https://youtu.be/${video.publishedVideoId}`
    : null;

  return (
    <Card className="overflow-hidden hover:border-primary/50 transition-colors group cursor-pointer relative">
      {/* Stretch link — sits above content so clicks navigate, interactive children use pointer-events-auto */}
      <Link
        href={`/video/${video._id}`}
        className="absolute inset-0 z-10"
        aria-label={`Open ${video.title}`}
      />

      {/* pointer-events-none so the stretch link receives all clicks here */}
      <div className="aspect-video bg-muted relative flex items-center justify-center pointer-events-none">
        {video.thumbnailUrl ? (
          <Image
            src={video.thumbnailUrl}
            alt={video.title}
            fill
            className="object-cover"
          />
        ) : (
          <Video className="w-10 h-10 text-muted-foreground/50 group-hover:text-primary/50 transition-colors" />
        )}

        <div className="absolute top-2 right-2 z-20 pointer-events-auto">
          <VideoStatusBadge status={video.status} />
        </div>

        {video.duration && (
          <div className="absolute bottom-2 right-2 z-20 bg-black/80 text-white text-xs px-1.5 py-0.5 rounded">
            {Math.floor(video.duration / 60)}:{(video.duration % 60).toString().padStart(2, "0")}
          </div>
        )}

        {youtubeUrl && (
          <a
            href={youtubeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-2 left-2 z-20 pointer-events-auto bg-primary text-primary-foreground text-xs px-2 py-1 rounded flex items-center gap-1 hover:opacity-90"
          >
            <Youtube className="w-3 h-3" /> YouTube
          </a>
        )}
      </div>

      {/* pointer-events-none so the stretch link receives clicks on the text area too */}
      <CardContent className="p-4 pointer-events-none">
        <h3 className="font-semibold line-clamp-2 mb-1 group-hover:text-primary transition-colors">
          {video.title}
        </h3>
        <div className="flex items-center text-xs text-muted-foreground">
          <span>{timeAgo}</span>
          <span className="mx-2">•</span>
          <span>{(video.rawFileSize / (1024 * 1024)).toFixed(1)} MB</span>
        </div>
      </CardContent>
    </Card>
  );
}
