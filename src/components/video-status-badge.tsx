import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, STATUS_COLORS } from "@/types/video";
import type { VideoStatus } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function VideoStatusBadge({ status, className }: { status: VideoStatus; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("px-2 py-0.5 font-medium border-0", STATUS_COLORS[status], className)}
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}
