"use client";

import Link from "next/link";
import type { Route } from "next";
import { useId, useState, type ReactNode } from "react";
import { api, useQuery, useMutation } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { SkeletonBar, TableSkeleton } from "@/components/admin/shell/admin-skeleton";
import { jobTypeLabel } from "@/components/admin/shared/status";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { formatDateTimeEAT } from "@/lib/eat";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/** How many failed jobs to fetch. The strip shows "N+" when the list hits this cap; the table shows the first few. */
const FAILED_FETCH_LIMIT = 50;
const FAILED_TABLE_ROWS = 10;

function useStats() {
  return useQuery(api.admin.stats.getStats);
}
function useFailedJobs() {
  return useQuery(api.admin.jobs.listFailed, { limit: FAILED_FETCH_LIMIT });
}
type Stats = NonNullable<ReturnType<typeof useStats>>;
type FailedJobs = NonNullable<ReturnType<typeof useFailedJobs>>;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Needs attention ─────────────────────────────────────────────────────────

type AttentionItem = { key: string; count: number; capped?: boolean; label: string; href: string };

/** Failed jobs from the last 24 hours (the list itself is all-time, newest first). */
function recentFailures(jobs: FailedJobs) {
  const cutoff = Date.now() - DAY_MS;
  const recent = jobs.filter((job) => (job.completedAt ?? job.startedAt ?? job.createdAt ?? 0) >= cutoff);
  // The fetch is capped, so when every row fetched is recent there may be more behind them.
  return { count: recent.length, capped: jobs.length >= FAILED_FETCH_LIMIT && recent.length === jobs.length };
}

function AttentionStrip({ failedJobs }: { failedJobs: FailedJobs | undefined }) {
  const billing = useQuery(api.admin.billing.overview);
  const loading = failedJobs === undefined || billing === undefined;

  const items: AttentionItem[] = [];
  if (!loading) {
    const failed = recentFailures(failedJobs);
    if (failed.count > 0) {
      items.push({
        key: "jobs",
        count: failed.count,
        capped: failed.capped,
        label: failed.count === 1 ? "failed job in the last 24 hours" : "failed jobs in the last 24 hours",
        href: "/admin/jobs?tab=failed",
      });
    }
    if (billing.needsReviewCount > 0) {
      items.push({
        key: "review",
        count: billing.needsReviewCount,
        label: billing.needsReviewCount === 1 ? "payment needs review" : "payments need review",
        href: "/admin/billing/review",
      });
    }
    if (billing.subscriptions.pastDue > 0) {
      items.push({
        key: "past-due",
        count: billing.subscriptions.pastDue,
        label: billing.subscriptions.pastDue === 1 ? "subscription past due" : "subscriptions past due",
        href: "/admin/billing/subscriptions?status=past_due",
      });
    }
  }

  return (
    <section
      aria-labelledby="attention-heading"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border px-4 py-3"
    >
      <h2 id="attention-heading" className="text-sm font-medium">
        Needs attention
      </h2>
      {loading ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading…</span>
          <SkeletonBar className="h-4 w-64" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing needs attention.</p>
      ) : (
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href as Route}
                className="group inline-flex items-baseline gap-1.5 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-hidden="true" className="size-1.5 shrink-0 translate-y-[-1px] self-center rounded-full bg-warning" />
                <span className="font-semibold tabular-nums">
                  {item.count}
                  {item.capped ? "+" : ""}
                </span>
                <span className="text-muted-foreground transition-colors duration-150 group-hover:text-foreground group-hover:underline motion-reduce:transition-none">
                  {item.label}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AttentionFallback() {
  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border px-4 py-3">
      <h2 className="text-sm font-medium">Needs attention</h2>
      <p className="text-sm text-muted-foreground">
        Couldn&apos;t load this summary. Check{" "}
        <Link href={"/admin/jobs" as Route} className="underline underline-offset-2 hover:text-foreground">
          jobs
        </Link>{" "}
        and{" "}
        <Link href={"/admin/billing/review" as Route} className="underline underline-offset-2 hover:text-foreground">
          payments to review
        </Link>{" "}
        directly.
      </p>
    </section>
  );
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

function Metric({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{value}</dd>
      {note !== undefined ? <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">{note}</div> : null}
    </div>
  );
}

function MetricStrip({ stats }: { stats: Stats | undefined }) {
  const loading = stats === undefined;
  const rate = stats?.successRate24h;
  const hasRate = typeof rate === "number";
  const bar = (className: string) => <SkeletonBar className={className} />;

  return (
    <section
      aria-label="Platform metrics"
      aria-busy={loading}
      className="grid rounded-lg border bg-card lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
    >
      <div className="border-b p-5 lg:border-b-0 lg:border-r">
        <p className="text-sm font-medium text-muted-foreground">Publish success, last 24 hours</p>
        <div className="mt-2 text-4xl font-bold leading-none tracking-tight tabular-nums">
          {loading ? bar("h-9 w-24") : hasRate ? `${Math.round(rate * 100)}%` : "N/A"}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {loading || hasRate
            ? "Share of publish jobs that finished successfully."
            : "No publish jobs finished in the last 24 hours."}
        </p>
      </div>
      <dl className="grid grid-cols-2 content-center gap-x-6 gap-y-5 p-5 sm:grid-cols-3">
        <Metric
          label="Users"
          value={loading ? bar("h-6 w-14") : stats.totalUsers}
          note={loading ? bar("h-3 w-24") : `${stats.youtubeConnected} with YouTube`}
        />
        <Metric
          label="Videos"
          value={loading ? bar("h-6 w-14") : stats.totalVideos}
          note={loading ? bar("h-3 w-24") : `${stats.publishedVideos} published`}
        />
        <Metric label="Jobs today" value={loading ? bar("h-6 w-14") : stats.jobsToday} />
        <Metric
          label="Auto-publish on"
          value={loading ? bar("h-6 w-14") : stats.autoPublishActive}
          note={loading ? bar("h-3 w-20") : "users"}
        />
        <Metric label="Storage" value={loading ? bar("h-6 w-20") : formatBytes(stats.totalStorageBytes)} />
      </dl>
    </section>
  );
}

// ─── Failed jobs ─────────────────────────────────────────────────────────────

function FailedJobsTable({ jobs }: { jobs: ReturnType<typeof useFailedJobs> }) {
  return (
    <section aria-labelledby="failures-heading" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <h2 id="failures-heading" className="text-base font-semibold">
          Recent failures
        </h2>
        <Link
          href={"/admin/jobs" as Route}
          className="rounded-sm text-sm text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          View all jobs
        </Link>
      </div>
      <Card>
        <CardContent className="p-0">
          {jobs === undefined ? (
            <TableSkeleton rows={4} cols={5} />
          ) : jobs.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium">No failed jobs</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                Publish and generation jobs that fail will show up here so you can follow up.
              </p>
              <Link
                href={"/admin/jobs" as Route}
                className="mt-3 inline-block rounded-sm text-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Browse all jobs
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">Type</th>
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">Video</th>
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">User</th>
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">Error</th>
                    <th className="px-4 py-2.5 font-medium text-muted-foreground">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.slice(0, FAILED_TABLE_ROWS).map((job) => (
                    <tr key={job._id} className="h-11 border-b transition-colors duration-150 last:border-0 hover:bg-muted/30 motion-reduce:transition-none">
                      <td className="px-4">
                        <span className="inline-flex items-center gap-2">
                          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
                          {jobTypeLabel(job.type)}
                          <span className="sr-only"> (failed)</span>
                        </span>
                      </td>
                      <td className="max-w-[160px] truncate px-4">{job.videoTitle ?? "—"}</td>
                      <td className="max-w-[160px] truncate px-4 text-muted-foreground">{job.userEmail ?? "—"}</td>
                      <td className="max-w-[260px] truncate px-4 text-destructive" title={job.error ?? undefined}>
                        {job.error ? job.error.slice(0, 60) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 tabular-nums text-muted-foreground">
                        {job.startedAt ? formatDateTimeEAT(job.startedAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
// ─── Broadcast ───────────────────────────────────────────────────────────────

function BroadcastForm() {
  const broadcastToAll = useMutation(api.admin.notifications.broadcastToAll);
  const uid = useId();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [type, setType] = useState<"info" | "success" | "warning" | "error">("info");
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  async function handleBroadcast() {
    if (!title.trim() || !message.trim()) return;
    setIsSending(true);
    setBroadcastResult(null);
    try {
      const result = await broadcastToAll({ title: title.trim(), message: message.trim(), type });
      setBroadcastResult(`Sent to ${(result as { count?: number })?.count ?? "all"} users`);
      setTitle("");
      setMessage("");
    } catch {
      setBroadcastResult("Failed to send notification.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section aria-labelledby="broadcast-heading" className="space-y-3">
      <h2 id="broadcast-heading" className="text-base font-semibold">
        Broadcast notification
      </h2>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Send to all users</CardTitle>
          <CardDescription>Push an in-app notification to every user on the platform.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`${uid}-title`} className="text-sm font-medium">
              Title
            </label>
            <Input
              id={`${uid}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Notification title"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${uid}-message`} className="text-sm font-medium">
              Message
            </label>
            <Textarea
              id={`${uid}-message`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Notification message"
              rows={3}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${uid}-type`} className="text-sm font-medium">
              Type
            </label>
            <Select
              id={`${uid}-type`}
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              className="w-40"
            >
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button onClick={handleBroadcast} disabled={isSending || !title.trim() || !message.trim()}>
              {isSending ? "Sending..." : "Send to all users"}
            </Button>
            <p role="status" className="text-sm text-muted-foreground">
              {broadcastResult}
            </p>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AdminOverviewPage() {
  const stats = useStats();
  const failedJobs = useFailedJobs();

  return (
    <AdminPage title="Overview" description="What needs action now, and how the platform is doing.">
      <ErrorBoundary fallback={<AttentionFallback />}>
        <AttentionStrip failedJobs={failedJobs} />
      </ErrorBoundary>
      <MetricStrip stats={stats} />
      <FailedJobsTable jobs={failedJobs} />
      <BroadcastForm />
    </AdminPage>
  );
}
