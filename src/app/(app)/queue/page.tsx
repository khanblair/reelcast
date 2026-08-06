"use client";

import { useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import {
  GripVertical,
  ArrowUp,
  ArrowDown,
  Play,
  ListOrdered,
  CheckCircle,
  XCircle,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDateTimeEAT } from "@/lib/eat";

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number) {
  if (!bytes) return "";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ─── types ────────────────────────────────────────────────────────────────────

type QueueItem = {
  _id: Id<"videos">;
  title: string;
  thumbnailUrl?: string | null;
  status: string;
  scheduledPublishAt?: number | null;
  publishOrder?: number | null;
  duration?: number | null;
  privacyStatus?: string | null;
  publishAs?: string | null;
  rawFileSize?: number | null;
};

type PublishState = "idle" | "publishing" | "success" | "error";

// ─── component ────────────────────────────────────────────────────────────────

export default function QueuePage() {
  const queueRaw = useQuery(api.queue.list);
  const stats = useQuery(api.queue.getQueueStats);
  const bulkSetPublishOrder = useMutation(api.queue.bulkSetPublishOrder);
  const publishNow = useAction(api.actions.publishNow.publishNow);

  // Per-item publish feedback: idle | publishing | success | error
  const [publishState, setPublishState] = useState<Record<string, PublishState>>({});
  const [publishError, setPublishError] = useState<Record<string, string>>({});

  // ── normalise order ──────────────────────────────────────────────────────
  // If the backend hasn't assigned publishOrder yet, use array position.
  const queue: QueueItem[] = (queueRaw ?? []).map((item, idx) => ({
    ...item,
    publishOrder: item.publishOrder ?? idx + 1,
  }));

  // ── reorder helpers ──────────────────────────────────────────────────────

  async function moveItem(index: number, direction: "up" | "down") {
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= queue.length) return;

    const a = queue[index];
    const b = queue[swapIndex];

    await bulkSetPublishOrder({
      orders: [
        { videoId: a._id, publishOrder: b.publishOrder ?? swapIndex + 1 },
        { videoId: b._id, publishOrder: a.publishOrder ?? index + 1 },
      ],
    });
  }

  // ── publish now ──────────────────────────────────────────────────────────

  async function handlePublishNow(videoId: Id<"videos">) {
    const key = videoId as string;
    setPublishState((prev) => ({ ...prev, [key]: "publishing" }));
    setPublishError((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    try {
      await publishNow({ videoId });
      setPublishState((prev) => ({ ...prev, [key]: "success" }));
      setTimeout(() => {
        setPublishState((prev) => ({ ...prev, [key]: "idle" }));
      }, 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Publish failed";
      setPublishState((prev) => ({ ...prev, [key]: "error" }));
      setPublishError((prev) => ({ ...prev, [key]: msg }));
    }
  }

  // ── loading / empty ──────────────────────────────────────────────────────

  if (queueRaw === undefined || stats === undefined) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="max-w-4xl mx-auto space-y-8 py-8">
        <PageHeader />
        <EmptyState
          icon={ListOrdered}
          title="Queue is empty"
          description="Add ready videos to your queue from the Library."
        />
      </div>
    );
  }

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-8">
      <PageHeader />

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Ready" value={stats.readyCount} accent="text-green-600 dark:text-green-400" />
        <StatCard label="Scheduled" value={stats.scheduledCount} accent="text-yellow-600 dark:text-yellow-400" />
        <StatCard
          label="Next publish"
          value={stats.nextPublishAt ? formatDateTimeEAT(stats.nextPublishAt) : "Not scheduled"}
          accent="text-muted-foreground"
          small
        />
      </div>

      {/* Queue list */}
      <div className="space-y-3">
        {queue.map((item, idx) => {
          const key = item._id as string;
          const state = publishState[key] ?? "idle";
          const errMsg = publishError[key];

          return (
            <Card key={key} className="overflow-hidden">
              <CardContent className="p-3">
                <div className="flex items-center gap-3">
                  {/* Drag handle (visual only, no DnD library) */}
                  <GripVertical className="h-5 w-5 shrink-0 cursor-grab text-muted-foreground" aria-hidden="true" />

                  {/* Thumbnail */}
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-muted">
                    {item.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbnailUrl}
                        alt={item.title}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="h-full w-full bg-muted" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate text-sm font-medium leading-tight">{item.title}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={item.status} />
                      {item.status === "scheduled" && item.scheduledPublishAt ? (
                        <span className="text-xs text-muted-foreground">
                          {formatDateTimeEAT(item.scheduledPublishAt)}
                        </span>
                      ) : null}
                      {item.rawFileSize ? (
                        <span className="text-xs text-muted-foreground">
                          {formatBytes(item.rawFileSize)}
                        </span>
                      ) : null}
                    </div>

                    {/* Inline feedback */}
                    {state === "success" && (
                      <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                        <CheckCircle className="h-3.5 w-3.5" />
                        <span>Published!</span>
                      </div>
                    )}
                    {state === "error" && errMsg && (
                      <div className="flex items-center gap-1 text-xs text-destructive">
                        <XCircle className="h-3.5 w-3.5" />
                        <span className="truncate">{errMsg}</span>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 items-center gap-1">
                    {/* Move up / down */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={idx === 0}
                      onClick={() => moveItem(idx, "up")}
                      aria-label="Move up"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={idx === queue.length - 1}
                      onClick={() => moveItem(idx, "down")}
                      aria-label="Move down"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>

                    {/* Publish Now */}
                    <Button
                      variant="default"
                      size="sm"
                      className="ml-1 gap-1.5"
                      disabled={state === "publishing" || state === "success"}
                      onClick={() => handlePublishNow(item._id)}
                    >
                      {state === "publishing" ? (
                        <LoadingSpinner size="sm" className="h-4 w-4" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                      {state === "publishing" ? "Publishing…" : "Publish Now"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────

function PageHeader() {
  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-bold tracking-tight">Publish Queue</h1>
      <p className="text-sm text-muted-foreground">
        Videos ready to go live. Drag to reorder or publish immediately.
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string | number;
  accent: string;
  small?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className={`mt-1 font-semibold ${accent} ${small ? "text-sm" : "text-2xl"} leading-tight`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "ready") {
    return (
      <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 text-xs">
        Ready
      </Badge>
    );
  }
  if (status === "scheduled") {
    return (
      <Badge variant="secondary" className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 text-xs">
        Scheduled
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs capitalize">
      {status}
    </Badge>
  );
}
