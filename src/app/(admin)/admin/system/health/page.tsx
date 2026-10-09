"use client";

import { useState } from "react";
import { ShieldAlert, KeyRound, Loader2, TriangleAlert, Check } from "lucide-react";
import { api, useQuery, useAction } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { SkeletonBar, TableSkeleton } from "@/components/admin/shell/admin-skeleton";
import { EmptyState } from "@/components/admin/billing/empty-state";
import type { Tone } from "@/components/admin/billing/format";
import { StatusDot } from "@/components/admin/billing/status-dot";
import { Td, Th } from "@/components/admin/billing/table-parts";
import { SectionCard } from "@/components/admin/shared/section-card";
import { oauthStatus, videoStatus } from "@/components/admin/shared/status";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTimeEAT } from "@/lib/eat";

export default function AdminHealthPage() {
  const storageHealth = useQuery(api.admin.health.getStorageHealth);
  const tokenHealth = useQuery(api.admin.health.getTokenHealth);
  const checkAllStorage = useAction(api.actions.storageHealth.checkAllUsersStorageHealth);
  const checkAllTokens = useAction(api.actions.oauthHealthCheck.checkAllChannelsOAuthHealth);

  const [storageChecking, setStorageChecking] = useState(false);
  const [storageResult, setStorageResult] = useState<{
    checked: number;
    missing: number;
    healthy: number;
  } | null>(null);
  const [tokensChecking, setTokensChecking] = useState(false);

  async function handleCheckStorage() {
    setStorageChecking(true);
    try {
      const result = await checkAllStorage();
      setStorageResult(result);
    } finally {
      setStorageChecking(false);
    }
  }

  async function handleCheckTokens() {
    setTokensChecking(true);
    try {
      await checkAllTokens();
    } finally {
      setTokensChecking(false);
    }
  }

  return (
    <AdminPage
      title="System health"
      description="Platform-wide storage and YouTube token status across all users."
    >
      {/* Storage health */}
      <SectionCard
        title="Storage health"
        description="Every ready or scheduled video's source file, verified against Cloudinary."
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheckStorage}
            disabled={storageChecking}
          >
            {storageChecking ? (
              <>
                <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                Checking all users…
              </>
            ) : (
              <>
                <ShieldAlert aria-hidden className="size-4" />
                Check all users
              </>
            )}
          </Button>
        }
      >
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatBlock label="Healthy" value={storageHealth?.healthyCount} tone="success" />
            <StatBlock
              label="Missing"
              value={storageHealth?.missingCount}
              tone={storageHealth && storageHealth.missingCount > 0 ? "danger" : "success"}
            />
            <StatBlock label="Never checked" value={storageHealth?.uncheckedCount} tone="neutral" />
          </div>

          {storageResult && (
            <p
              role="status"
              className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm"
            >
              {storageResult.missing > 0 ? (
                <TriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
              ) : (
                <Check aria-hidden className="size-4 shrink-0 text-success" />
              )}
              <span>
                Just checked {storageResult.checked} video{storageResult.checked !== 1 ? "s" : ""} —{" "}
                {storageResult.healthy} healthy
                {storageResult.missing > 0 && `, ${storageResult.missing} missing`}.
              </span>
            </p>
          )}

          {storageHealth === undefined ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <TableSkeleton rows={3} cols={4} />
            </div>
          ) : storageHealth.missingVideos.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Video</Th>
                    <Th>User</Th>
                    <Th>Status</Th>
                    <Th>Checked</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {storageHealth.missingVideos.map((v) => (
                    <TableRow key={v.videoId}>
                      <Td className="max-w-[280px] truncate" title={v.title}>
                        {v.title}
                      </Td>
                      <Td className="text-muted-foreground">{v.userEmail}</Td>
                      <Td className="text-muted-foreground">{videoStatus(v.status).label}</Td>
                      <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {v.checkedAt ? formatDateTimeEAT(v.checkedAt) : "—"}
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No missing source files. Run a check to verify every video again.
            </p>
          )}
        </div>
      </SectionCard>

      {/* Token health */}
      <SectionCard
        title="YouTube token health"
        description="Every connected channel (primary and secondary) across all users."
        action={
          <Button variant="outline" size="sm" onClick={handleCheckTokens} disabled={tokensChecking}>
            {tokensChecking ? (
              <>
                <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
                Checking all channels…
              </>
            ) : (
              <>
                <KeyRound aria-hidden className="size-4" />
                Recheck all
              </>
            )}
          </Button>
        }
      >
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatBlock
              label="Connected"
              value={tokenHealth && (tokenHealth.counts.connected ?? 0)}
              tone="success"
            />
            <StatBlock
              label="Expired"
              value={tokenHealth && (tokenHealth.counts.token_expired ?? 0)}
              tone="pending"
            />
            <StatBlock
              label="Revoked"
              value={tokenHealth && (tokenHealth.counts.revoked ?? 0)}
              tone="danger"
            />
            <StatBlock
              label="Unknown"
              value={tokenHealth && (tokenHealth.counts.unknown ?? 0)}
              tone="neutral"
            />
          </div>

          {tokenHealth === undefined ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <TableSkeleton rows={4} cols={4} />
            </div>
          ) : tokenHealth.rows.length === 0 ? (
            <div className="rounded-lg border border-border">
              <EmptyState
                icon={KeyRound}
                title="No connected channels yet"
                description="Channels appear here once users connect YouTube from their settings. Their token status is checked automatically."
              />
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Channel</Th>
                    <Th>User</Th>
                    <Th>Role</Th>
                    <Th>Status</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tokenHealth.rows.map((r) => {
                    const status = oauthStatus(r.oauthStatus);
                    return (
                      <TableRow key={r.channelId}>
                        <Td className="max-w-[240px] truncate" title={r.channelName}>
                          {r.channelName}
                        </Td>
                        <Td className="text-muted-foreground">{r.userEmail}</Td>
                        <Td className="text-muted-foreground">
                          {r.isPrimary ? "Primary" : "Secondary"}
                        </Td>
                        <Td>
                          <StatusDot tone={status.tone} label={status.label} />
                        </Td>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </SectionCard>
    </AdminPage>
  );
}

/** A labelled count with a status dot. The label carries the meaning; the dot only supports it. */
function StatBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | undefined;
  tone: Tone;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-sm text-muted-foreground">
        <StatusDot tone={tone} label={label} />
      </p>
      {value === undefined ? (
        <SkeletonBar className="mt-2 h-7 w-10" />
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      )}
    </div>
  );
}
