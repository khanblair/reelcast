"use client";

import { useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Youtube, CheckCircle, AlertCircle, XCircle, Loader2, RefreshCw, Unplug } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type OAuthStatus = "connected" | "token_expired" | "revoked" | "unknown" | null | undefined;

function StatusBadge({ status }: { status: OAuthStatus }) {
  if (!status) return null;
  const variants: Record<string, { label: string; className: string }> = {
    connected: { label: "Connected", className: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400 border-green-200 dark:border-green-800" },
    token_expired: { label: "Token Expired", className: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800" },
    revoked: { label: "Revoked", className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 border-red-200 dark:border-red-800" },
    unknown: { label: "Unknown", className: "bg-muted text-muted-foreground border-border" },
  };
  const v = variants[status] ?? variants.unknown;
  return (
    <Badge variant="outline" className={cn("text-xs font-medium", v.className)}>
      {v.label}
    </Badge>
  );
}

export default function YouTubeSettingsPage() {
  const user = useQuery(api.users.current);
  const oauthStatus = useQuery(api.users.getOAuthStatus);
  const disconnectYoutube = useMutation(api.users.disconnectYoutube);
  const checkHealth = useAction(api.actions.oauthHealthCheck.checkMyOAuthHealth);

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [healthStatus, setHealthStatus] = useState<"idle" | "loading" | "done">("idle");
  const [healthResult, setHealthResult] = useState<{ status: OAuthStatus } | null>(null);

  if (user === undefined || oauthStatus === undefined) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const isConnected = oauthStatus?.youtubeConnected ?? false;
  const channelName = oauthStatus?.youtubeChannelName;
  const currentStatus = oauthStatus?.youtubeOAuthStatus as OAuthStatus;

  const handleDisconnect = async () => {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    setDisconnecting(true);
    setConfirmDisconnect(false);
    try {
      await disconnectYoutube();
    } finally {
      setDisconnecting(false);
    }
  };

  const handleCheckHealth = async () => {
    setHealthStatus("loading");
    setHealthResult(null);
    try {
      const result = await checkHealth();
      setHealthResult({ status: result.status as OAuthStatus });
      setHealthStatus("done");
    } catch {
      setHealthStatus("done");
      setHealthResult({ status: "unknown" });
    }
  };

  const healthMessage = () => {
    if (!healthResult) return null;
    switch (healthResult.status) {
      case "connected": return { text: "Token is valid and working.", icon: CheckCircle, color: "text-green-600 dark:text-green-400" };
      case "token_expired": return { text: "Token expired — please reconnect.", icon: AlertCircle, color: "text-yellow-600 dark:text-yellow-400" };
      case "revoked": return { text: "Access was revoked — please reconnect.", icon: XCircle, color: "text-red-600 dark:text-red-400" };
      default: return { text: "Status unknown — check your connection.", icon: AlertCircle, color: "text-muted-foreground" };
    }
  };

  const healthMsg = healthMessage();

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Youtube className="h-6 w-6 text-primary" />
          YouTube Connection
        </h1>
        <p className="text-muted-foreground mt-1">
          Manage your YouTube account connection and OAuth health.
        </p>
      </div>

      {/* Connection status card */}
      <Card>
        <CardHeader>
          <CardTitle>Connection Status</CardTitle>
          <CardDescription>
            {isConnected
              ? "Your YouTube account is linked to Reelcast."
              : "Connect your YouTube account to enable publishing."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isConnected ? (
            <>
              <div className="flex items-center gap-3 rounded-lg border bg-green-50/50 dark:bg-green-950/30 border-green-200 dark:border-green-800 p-3">
                <div className="h-3 w-3 rounded-full bg-green-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-green-700 dark:text-green-300">
                    {channelName ? channelName : "YouTube Connected"}
                  </p>
                  {currentStatus && (
                    <div className="mt-1">
                      <StatusBadge status={currentStatus} />
                    </div>
                  )}
                </div>
              </div>

              {/* Health check result */}
              {healthStatus === "done" && healthMsg && (
                <div className={cn("flex items-center gap-2 rounded-lg border p-3 text-sm", healthMsg.color)}>
                  <healthMsg.icon className="h-4 w-4 shrink-0" />
                  {healthMsg.text}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCheckHealth}
                  disabled={healthStatus === "loading"}
                >
                  {healthStatus === "loading" ? (
                    <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Checking...</>
                  ) : (
                    <><RefreshCw className="h-4 w-4 mr-1" />Check health</>
                  )}
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { window.location.href = "/api/youtube/connect"; }}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Reconnect
                </Button>

                {confirmDisconnect ? (
                  <div className="flex gap-2 items-center">
                    <span className="text-xs text-muted-foreground">Are you sure?</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                    >
                      {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Yes, disconnect"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDisconnect(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDisconnect}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    <Unplug className="h-4 w-4 mr-1" />
                    Disconnect
                  </Button>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
                <div className="h-3 w-3 rounded-full bg-muted-foreground/40 shrink-0" />
                <p className="text-sm text-muted-foreground">No YouTube account connected</p>
              </div>
              <Button onClick={() => { window.location.href = "/api/youtube/connect"; }}>
                <Youtube className="h-4 w-4 mr-2" />
                Connect YouTube
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* OAuth status explanation */}
      <Card>
        <CardHeader>
          <CardTitle>OAuth Status Guide</CardTitle>
          <CardDescription>
            What each status means for your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {[
            { status: "connected" as OAuthStatus, icon: CheckCircle, color: "text-green-600 dark:text-green-400", desc: "Your access token is valid and publishing will work." },
            { status: "token_expired" as OAuthStatus, icon: AlertCircle, color: "text-yellow-600 dark:text-yellow-400", desc: "Your token has expired. Use Reconnect to restore access." },
            { status: "revoked" as OAuthStatus, icon: XCircle, color: "text-red-600 dark:text-red-400", desc: "YouTube revoked access. Reconnect to grant permissions again." },
            { status: "unknown" as OAuthStatus, icon: AlertCircle, color: "text-muted-foreground", desc: "Status could not be determined. Try checking health or reconnecting." },
          ].map((item) => (
            <div key={item.status} className="flex items-start gap-3 rounded-lg border p-3">
              <item.icon className={cn("h-4 w-4 mt-0.5 shrink-0", item.color)} />
              <div>
                <StatusBadge status={item.status} />
                <p className="text-xs text-muted-foreground mt-1">{item.desc}</p>
              </div>
            </div>
          ))}

          <p className="text-xs text-muted-foreground pt-2">
            The platform automatically checks your OAuth token health every 6 hours.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
