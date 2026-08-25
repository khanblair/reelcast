"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import {
  GripVertical,
  ArrowUp,
  ArrowDown,
  Play,
  ListOrdered,
  CheckCircle,
  XCircle,
  ShieldAlert,
  ShieldCheck,
  Loader2,
  AlertTriangle,
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
  storageMissing?: boolean;
  storageCheckedAt?: number | null;
};

type PublishState = "idle" | "publishing" | "success" | "error";

// ─── component ────────────────────────────────────────────────────────────────

export default function QueuePage() {
  const queueRaw = useQuery(api.queue.list);
  const stats = useQuery(api.queue.getQueueStats);
  const settings = useQuery(api.settings.get);
  const bulkSetPublishOrder = useMutation(api.queue.bulkSetPublishOrder);
  const publishNow = useAction(api.actions.publishNow.publishNow);
  const checkStorageHealth = useAction(api.actions.storageHealth.checkQueueStorageHealth);

  // Per-item publish feedback: idle | publishing | success | error
  const [publishState, setPublishState] = useState<Record<string, PublishState>>({});
  const [publishError, setPublishError] = useState<Record<string, string>>({});

  const [healthCheckState, setHealthCheckState] = useState<"idle" | "checking" | "done">("idle");
  const [healthResult, setHealthResult] = useState<{ checked: number; missing: number; healthy: number } | null>(null);

  async function handleCheckHealth() {
    setHealthCheckState("checking");
    try {
      const result = await checkStorageHealth();
      setHealthResult(result);
      setHealthCheckState("done");
    } catch {
      setHealthCheckState("idle");
    }
  }

  // ── normalise order ──────────────────────────────────────────────────────
  // If the backend hasn't assigned publishOrder yet, use array position.
  const queue: QueueItem[] = (queueRaw ?? []).map((item, idx) => ({
    ...item,
    publishOrder: item.publishOrder ?? idx + 1,
  }));

  const missingCount = queue.filter((item) => item.storageMissing).length;

  // ── next video that will actually publish (skips known-dead files) ──────
  // The next auto-publish run always grabs whichever healthy video is first
  // in the queue (the backend skips storageMissing ones — see autoPublish.ts),
  // so the first healthy item always lands at settings.autoPublishNextAt.
  const nextUp = useMemo(() => {
    if (!settings?.autoPublishEnabled || !settings.autoPublishNextAt) return null;

    const readyHealthy = queue
      .filter((item) => item.status === "ready" && !item.storageMissing)
      .sort((a, b) => (a.publishOrder ?? 0) - (b.publishOrder ?? 0));

    if (readyHealthy.length === 0) return null;

    return { title: readyHealthy[0].title, time: settings.autoPublishNextAt };
  }, [queue, settings]);

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

  if (queueRaw === undefined || stats === undefined || settings === undefined) {
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
          label="Files missing"
          value={missingCount}
          accent={missingCount > 0 ? "text-destructive" : "text-green-600 dark:text-green-400"}
        />
      </div>

      {/* Next up — the video that will actually publish, skipping known-dead files */}
      <Card className={nextUp ? undefined : "border-dashed"}>
        <CardContent className="p-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Next up</p>
          {nextUp ? (
            <div className="mt-1 flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-semibold truncate">{nextUp.title}</p>
              <p className="text-sm text-muted-foreground shrink-0">{formatDateTimeEAT(nextUp.time)}</p>
            </div>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              {stats.readyCount === 0
                ? "No ready videos in the queue."
                : missingCount === stats.readyCount
                ? "All ready videos have missing files — re-upload to resume auto-publishing."
                : "Auto-publish is not enabled."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Storage health check */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4" />
                Storage Health
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Verify every ready/scheduled video&apos;s file still exists on Cloudinary before it burns a publish attempt.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckHealth}
              disabled={healthCheckState === "checking"}
            >
              {healthCheckState === "checking" ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Checking…</>
              ) : (
                <><ShieldAlert className="h-4 w-4 mr-1.5" />Check Storage Health</>
              )}
            </Button>
          </div>

          {healthCheckState === "done" && healthResult && (
            <div
              className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${
                healthResult.missing > 0
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-green-200 bg-green-50/50 text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300"
              }`}
            >
              {healthResult.missing > 0 ? (
                <AlertTriangle className="h-4 w-4 shrink-0" />
              ) : (
                <CheckCircle className="h-4 w-4 shrink-0" />
              )}
              <span>
                Checked {healthResult.checked} video{healthResult.checked !== 1 ? "s" : ""} —{" "}
                {healthResult.healthy} healthy
                {healthResult.missing > 0 && `, ${healthResult.missing} missing (re-upload required)`}.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

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
                      {item.storageMissing && (
                        <Badge variant="outline" className="text-xs border-destructive/40 text-destructive bg-destructive/10">
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          File Missing
                        </Badge>
                      )}
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
                    {item.storageMissing && (
                      <p className="text-xs text-destructive">
                        Source file no longer exists in storage — re-upload to publish this video.
                      </p>
                    )}
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
                      disabled={state === "publishing" || state === "success" || item.storageMissing}
                      onClick={() => handlePublishNow(item._id)}
                      title={item.storageMissing ? "File missing from storage — re-upload first" : undefined}
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
