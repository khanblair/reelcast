"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "../../../../../convex/_generated/api";
import { Bell, Eye, EyeOff, Save, Loader2, ArrowLeft } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

export default function NotificationsSettingsPage() {
  const router = useRouter();
  const settings = useQuery(api.settings.get);
  const update = useMutation(api.settings.update);

  const [resendKeyInput, setResendKeyInput] = useState("");
  const [resendKeyVisible, setResendKeyVisible] = useState(false);
  const [savingResend, setSavingResend] = useState(false);
  const [savedResend, setSavedResend] = useState(false);

  const [emailFromInput, setEmailFromInput] = useState("");
  const [savingEmailFrom, setSavingEmailFrom] = useState(false);
  const [savedEmailFrom, setSavedEmailFrom] = useState(false);

  if (settings === undefined) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const toggle = async (field: string, value: boolean) => {
    await update({ [field]: value } as Parameters<typeof update>[0]);
  };

  const saveResendKey = async () => {
    if (!resendKeyInput.trim()) return;
    setSavingResend(true);
    setSavedResend(false);
    try {
      await update({ resendApiKey: resendKeyInput.trim() });
      setResendKeyInput("");
      setSavedResend(true);
      setTimeout(() => setSavedResend(false), 2000);
    } finally {
      setSavingResend(false);
    }
  };

  const saveEmailFrom = async () => {
    if (!emailFromInput.trim()) return;
    setSavingEmailFrom(true);
    setSavedEmailFrom(false);
    try {
      await update({ emailFromAddress: emailFromInput.trim() });
      setSavedEmailFrom(true);
      setTimeout(() => setSavedEmailFrom(false), 2000);
    } finally {
      setSavingEmailFrom(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push("/settings")}
        className="-ml-1 text-muted-foreground"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back to Settings
      </Button>

      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Bell className="h-6 w-6 text-primary" />
          Notification Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Control which events trigger notifications and how they are delivered.
        </p>
      </div>

      {/* Master toggle */}
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>Enable or disable all notifications globally.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">Enable notifications</Label>
              <p className="text-[11px] text-muted-foreground">Master toggle for all notification channels</p>
            </div>
            <Switch
              checked={settings?.notificationsEnabled ?? false}
              onCheckedChange={(v) => toggle("notificationsEnabled", v)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Per-event toggles */}
      {settings?.notificationsEnabled && (
        <Card>
          <CardHeader>
            <CardTitle>Events</CardTitle>
            <CardDescription>Choose which events you want to be notified about.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              {
                label: "Publish success",
                description: "When a video is successfully published to YouTube",
                field: "notifyOnPublishSuccess",
                value: settings?.notifyOnPublishSuccess ?? false,
              },
              {
                label: "Publish failure",
                description: "When a publish attempt fails",
                field: "notifyOnPublishFailure",
                value: settings?.notifyOnPublishFailure ?? false,
              },
              {
                label: "Metadata ready",
                description: "When AI finishes generating metadata for a video",
                field: "notifyOnMetadataReady",
                value: settings?.notifyOnMetadataReady ?? false,
              },
              {
                label: "Weekly digest",
                description: "A weekly summary of your channel performance",
                field: "notifyOnWeeklyDigest",
                value: settings?.notifyOnWeeklyDigest ?? false,
              },
              {
                label: "Storage warning",
                description: "When your storage usage reaches a high threshold",
                field: "notifyOnStorageWarning",
                value: settings?.notifyOnStorageWarning ?? false,
              },
            ].map((item) => (
              <div key={item.field} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label className="text-sm font-medium">{item.label}</Label>
                  <p className="text-[11px] text-muted-foreground">{item.description}</p>
                </div>
                <Switch
                  checked={item.value}
                  onCheckedChange={(v) => toggle(item.field, v)}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Email notifications (BYOK Resend) */}
      <Card>
        <CardHeader>
          <CardTitle>Email Notifications</CardTitle>
          <CardDescription>
            Send notifications via email using your own Resend account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm font-medium">Email notifications</Label>
              <p className="text-[11px] text-muted-foreground">Deliver notifications to your email address</p>
            </div>
            <Switch
              checked={settings?.emailNotificationsEnabled ?? false}
              onCheckedChange={(v) => toggle("emailNotificationsEnabled", v)}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Resend API Key</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={resendKeyVisible ? "text" : "password"}
                  placeholder={settings?.resendApiKey ? "••••••••••••••••" : "re_..."}
                  value={resendKeyInput}
                  onChange={(e) => setResendKeyInput(e.target.value)}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setResendKeyVisible((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {resendKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                variant="outline"
                onClick={saveResendKey}
                disabled={savingResend || !resendKeyInput.trim()}
              >
                {savingResend ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : savedResend ? (
                  "Saved!"
                ) : (
                  <>
                    <Save className="h-4 w-4 mr-1" />
                    Save
                  </>
                )}
              </Button>
            </div>
            {settings?.resendApiKey && (
              <p className="text-[11px] text-muted-foreground">API key is set. Enter a new value above to replace it.</p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">From address</Label>
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="notifications@yourdomain.com"
                value={emailFromInput || settings?.emailFromAddress || ""}
                onChange={(e) => setEmailFromInput(e.target.value)}
                className="flex-1"
              />
              <Button
                variant="outline"
                onClick={saveEmailFrom}
                disabled={savingEmailFrom || !emailFromInput.trim()}
              >
                {savingEmailFrom ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : savedEmailFrom ? (
                  "Saved!"
                ) : (
                  <>
                    <Save className="h-4 w-4 mr-1" />
                    Save
                  </>
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Must be a verified sender in your Resend account.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
