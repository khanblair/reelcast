"use client";

import { useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Briefcase, Film } from "lucide-react";
import { api, useQuery, useMutation } from "@/lib/rpc/client";
import type { Id } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { PanelSkeleton } from "@/components/admin/shell/admin-skeleton";
import { UserBillingCard } from "@/components/admin/billing/user-billing-card";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { FilterChips } from "@/components/admin/billing/filters";
import { planLabel } from "@/components/admin/billing/format";
import { StatusDot } from "@/components/admin/billing/status-dot";
import { Td, Th } from "@/components/admin/billing/table-parts";
import { LinkButton } from "@/components/admin/shared/link-button";
import { SectionCard } from "@/components/admin/shared/section-card";
import {
  jobStatus,
  jobTypeLabel,
  oauthStatus,
  videoStatus,
} from "@/components/admin/shared/status";
import type { PlanKey } from "@/components/billing/plans";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";

function formatDate(ms: number | undefined | null) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

const PLAN_OPTIONS: ReadonlyArray<{ value: PlanKey; label: string }> = [
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "elite", label: "Elite" },
];

function BackToUsers() {
  return (
    <LinkButton href="/admin/users">
      <ArrowLeft aria-hidden className="size-4" />
      Users
    </LinkButton>
  );
}

/** One label/value row of the account panel. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-3 py-2 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default function AdminUserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const data = useQuery(api.admin.users.getWithDetails, {
    userId: userId as Id,
  });

  const setAdmin = useMutation(api.admin.users.setAdmin);
  const setPlan = useMutation(api.admin.users.setPlan);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The server enforces the rules (admin-only, no self-demotion, never the last admin);
  // surface its message instead of an unhandled rejection.
  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  if (data === undefined) {
    return (
      <AdminPage title="User" actions={<BackToUsers />}>
        <div className="grid gap-6 lg:grid-cols-2">
          <PanelSkeleton lines={5} />
          <PanelSkeleton lines={4} />
        </div>
        <PanelSkeleton lines={4} />
        <PanelSkeleton lines={3} />
      </AdminPage>
    );
  }

  if (data === null) {
    return (
      <AdminPage
        title="User not found"
        description="No account matches this ID. It may have been deleted."
        actions={<BackToUsers />}
      >
        <p className="text-sm text-muted-foreground">
          Go back to the user list to find the account.
        </p>
      </AdminPage>
    );
  }

  const { user, videos, recentJobs, videoCount } = data;
  const currentPlan = (user.plan ?? "free") as PlanKey;
  const youtube = user.youtubeConnected
    ? oauthStatus(user.youtubeOAuthStatus ?? "connected")
    : null;
  const youtubeLabel =
    youtube && user.youtubeOAuthStatus && user.youtubeOAuthStatus !== "connected"
      ? `Connected (${youtube.label.toLowerCase()})`
      : "Connected";

  return (
    <AdminPage
      title={user.name ?? user.email}
      description={
        user.name || user.isAdmin ? (
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {user.name ? <span>{user.email}</span> : null}
            {user.name && user.isAdmin ? <span aria-hidden>·</span> : null}
            {user.isAdmin ? <span className="font-medium text-foreground">Admin</span> : null}
          </span>
        ) : undefined
      }
      actions={<BackToUsers />}
    >
      {actionError ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 px-4 py-3 text-sm text-destructive"
        >
          {actionError}
        </p>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SectionCard title="Account">
          <dl className="divide-y divide-border px-4 py-1 text-sm">
            <Field label="Email">{user.email}</Field>
            <Field label="Name">{user.name ?? "—"}</Field>
            <Field label="Plan">
              <span className="font-medium">{planLabel(user.plan)}</span>
              {user.planSource === "admin" ? (
                <span className="ml-2 text-xs text-muted-foreground">granted by an admin</span>
              ) : null}
            </Field>
            <Field label="YouTube">
              {youtube ? (
                <StatusDot tone={youtube.tone} label={youtubeLabel} />
              ) : (
                <StatusDot tone="neutral" label="Not connected" />
              )}
            </Field>
            <Field label="Member since">
              <span className="tabular-nums">{formatDate(user._creationTime)}</span>
            </Field>
          </dl>
        </SectionCard>

        <div className="space-y-6">
          <SectionCard title="Plan" description="Upgrade or downgrade this user's plan.">
            <div className="p-4">
              <FilterChips
                label="Set plan"
                options={PLAN_OPTIONS}
                value={currentPlan}
                disabled={busy}
                onChange={(plan) => run(() => setPlan({ userId: userId as Id, plan }))}
              />
            </div>
          </SectionCard>

          <SectionCard
            title="Admin access"
            description="Grant or revoke admin privileges for this user."
          >
            <div className="p-4">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                className={
                  user.isAdmin
                    ? "border-destructive/50 text-destructive hover:bg-destructive/10"
                    : undefined
                }
                onClick={() =>
                  run(() =>
                    setAdmin({
                      userId: userId as Id,
                      isAdmin: !user.isAdmin,
                    })
                  )
                }
              >
                {user.isAdmin ? "Revoke admin" : "Grant admin"}
              </Button>
            </div>
          </SectionCard>
        </div>
      </div>

      <UserBillingCard userId={userId} />

      <SectionCard title="Videos" meta={videoCount}>
        {videos.length === 0 ? (
          <EmptyState
            icon={Film}
            title="No videos yet"
            description="Videos this user uploads or generates will be listed here."
          />
        ) : (
          <Table className="min-w-[520px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Published at</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {videos.map((v) => {
                const status = videoStatus(v.status);
                return (
                  <TableRow key={v._id}>
                    <Td className="max-w-[280px] truncate">{v.title ?? "Untitled"}</Td>
                    <Td>
                      <StatusDot tone={status.tone} label={status.label} />
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {v.status === "published" ? formatDate(v.publishedAt) : "—"}
                    </Td>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard title="Recent jobs">
        {recentJobs.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No jobs yet"
            description="Publish and generation jobs for this user will be listed here."
          />
        ) : (
          <Table className="min-w-[520px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Started at</Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentJobs.map((j) => {
                const status = jobStatus(j.status);
                return (
                  <TableRow key={j._id}>
                    <Td>{jobTypeLabel(j.type)}</Td>
                    <Td>
                      <StatusDot tone={status.tone} label={status.label} />
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatDate(j.startedAt)}
                    </Td>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </AdminPage>
  );
}
