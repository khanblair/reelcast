"use client";

import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { HeartPulse, ShieldAlert, ShieldCheck, KeyRound, Loader2, AlertTriangle, CheckCircle } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDateTimeEAT } from "@/lib/eat";

const TOKEN_STATUS_STYLE: Record<string, string> = {
  connected: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800",
  token_expired: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800",
  revoked: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 border-red-200 dark:border-red-800",
  unknown: "bg-muted text-muted-foreground border-border",
};

export default function AdminHealthPage() {
  const storageHealth = useQuery(api.admin.health.getStorageHealth);
  const tokenHealth = useQuery(api.admin.health.getTokenHealth);
  const checkAllStorage = useAction(api.actions.storageHealth.checkAllUsersStorageHealth);
  const checkAllTokens = useAction(api.actions.oauthHealthCheck.checkAllChannelsOAuthHealth);

  const [storageChecking, setStorageChecking] = useState(false);
  const [storageResult, setStorageResult] = useState<{ checked: number; missing: number; healthy: number } | null>(null);
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

  if (storageHealth === undefined || tokenHealth === undefined) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <HeartPulse className="h-6 w-6 text-muted-foreground" />
          System Health
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Platform-wide storage and YouTube token status across all users.
        </p>
      </div>

      {/* Storage health */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-muted-foreground" />
                Storage Health
              </CardTitle>
              <CardDescription>
                Every ready/scheduled video&apos;s source file, verified against Cloudinary.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleCheckStorage} disabled={storageChecking}>
              {storageChecking ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Checking all users…</>
              ) : (
                <><ShieldAlert className="h-4 w-4 mr-1.5" />Check All Users</>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <StatBlock label="Healthy" value={storageHealth.healthyCount} accent="text-green-600 dark:text-green-400" />
            <StatBlock
              label="Missing"
              value={storageHealth.missingCount}
              accent={storageHealth.missingCount > 0 ? "text-destructive" : "text-green-600 dark:text-green-400"}
            />
            <StatBlock label="Never checked" value={storageHealth.uncheckedCount} accent="text-muted-foreground" />
          </div>

          {storageResult && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border p-3 text-sm",
                storageResult.missing > 0
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-green-200 bg-green-50/50 text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-300"
              )}
            >
              {storageResult.missing > 0 ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <CheckCircle className="h-4 w-4 shrink-0" />}
              <span>
                Just checked {storageResult.checked} video{storageResult.checked !== 1 ? "s" : ""} — {storageResult.healthy} healthy
                {storageResult.missing > 0 && `, ${storageResult.missing} missing`}.
              </span>
            </div>
          )}

          {storageHealth.missingVideos.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left bg-muted/30">
                    <th className="px-4 py-2 font-medium text-muted-foreground">Video</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">User</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {storageHealth.missingVideos.map((v) => (
                    <tr key={v.videoId} className="border-b last:border-0">
                      <td className="px-4 py-2 max-w-[280px] truncate">{v.title}</td>
                      <td className="px-4 py-2 text-muted-foreground">{v.userEmail}</td>
                      <td className="px-4 py-2 capitalize text-muted-foreground">{v.status}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {v.checkedAt ? formatDateTimeEAT(v.checkedAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Token health */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5 text-muted-foreground" />
                YouTube Token Health
              </CardTitle>
              <CardDescription>
                Every connected channel (primary and secondary) across all users.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleCheckTokens} disabled={tokensChecking}>
              {tokensChecking ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Checking all channels…</>
              ) : (
                <><KeyRound className="h-4 w-4 mr-1.5" />Recheck All</>
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
            <StatBlock label="Connected" value={tokenHealth.counts.connected ?? 0} accent="text-green-600 dark:text-green-400" />
            <StatBlock label="Expired" value={tokenHealth.counts.token_expired ?? 0} accent="text-yellow-600 dark:text-yellow-400" />
            <StatBlock label="Revoked" value={tokenHealth.counts.revoked ?? 0} accent="text-destructive" />
            <StatBlock label="Unknown" value={tokenHealth.counts.unknown ?? 0} accent="text-muted-foreground" />
          </div>

          {tokenHealth.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No connected channels yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left bg-muted/30">
                    <th className="px-4 py-2 font-medium text-muted-foreground">Channel</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">User</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Role</th>
                    <th className="px-4 py-2 font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenHealth.rows.map((r) => (
                    <tr key={r.channelId} className="border-b last:border-0">
                      <td className="px-4 py-2 max-w-[220px] truncate">{r.channelName}</td>
                      <td className="px-4 py-2 text-muted-foreground">{r.userEmail}</td>
                      <td className="px-4 py-2 text-muted-foreground">{r.isPrimary ? "Primary" : "Secondary"}</td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className={cn("text-xs capitalize", TOKEN_STATUS_STYLE[r.oauthStatus] ?? TOKEN_STATUS_STYLE.unknown)}>
                          {r.oauthStatus.replace("_", " ")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatBlock({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold", accent)}>{value}</p>
    </div>
  );
}
