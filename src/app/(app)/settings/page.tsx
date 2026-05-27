"use client";

import { useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Youtube, MessageCircle, CheckCircle, XCircle, Settings } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

type TestResult = { success: boolean; message: string } | null;

export default function SettingsPage() {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);
  const disconnectYoutube = useMutation(api.users.disconnectYoutube);
  const disconnectTelegram = useMutation(api.settings.disconnectTelegram);
  const testYoutube = useAction(api.actions.testConnections.testYoutube);
  const testTelegram = useAction(api.actions.testConnections.testTelegram);

  const [telegramInput, setTelegramInput] = useState("");
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [disconnectingYoutube, setDisconnectingYoutube] = useState(false);
  const [testingYoutube, setTestingYoutube] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [youtubeTestResult, setYoutubeTestResult] = useState<TestResult>(null);
  const [telegramTestResult, setTelegramTestResult] = useState<TestResult>(null);

  if (settings === undefined) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  if (settings === null) {
    return (
      <EmptyState
        icon={Settings}
        title="Settings not found"
        description="User settings could not be loaded. Please try again."
      />
    );
  }

  const handleSaveTelegram = async () => {
    const value = telegramInput.trim();
    if (!value) return;
    setSavingTelegram(true);
    try {
      await updateSettings({ telegramChatId: value });
      setTelegramInput("");
    } finally {
      setSavingTelegram(false);
    }
  };

  const handleDisconnectYoutube = async () => {
    setDisconnectingYoutube(true);
    setYoutubeTestResult(null);
    try {
      await disconnectYoutube();
    } finally {
      setDisconnectingYoutube(false);
    }
  };

  const handleTestYoutube = async () => {
    setTestingYoutube(true);
    setYoutubeTestResult(null);
    try {
      const result = await testYoutube({});
      setYoutubeTestResult(
        result.success
          ? { success: true, message: `Connected to "${result.channelName}"` }
          : { success: false, message: result.error ?? "Connection failed." }
      );
    } catch (e) {
      setYoutubeTestResult({ success: false, message: e instanceof Error ? e.message : "Unknown error." });
    } finally {
      setTestingYoutube(false);
    }
  };

  const handleTestTelegram = async () => {
    setTestingTelegram(true);
    setTelegramTestResult(null);
    try {
      const result = await testTelegram({});
      setTelegramTestResult(
        result.success
          ? { success: true, message: "Test message sent! Check your Telegram." }
          : { success: false, message: result.error ?? "Connection failed." }
      );
    } catch (e) {
      setTelegramTestResult({ success: false, message: e instanceof Error ? e.message : "Unknown error." });
    } finally {
      setTestingTelegram(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Settings</h1>
        <p className="text-muted-foreground">Manage your connections, notifications, and default preferences.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* YouTube Connection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Youtube className="h-5 w-5 text-primary" />
              YouTube Connection
            </CardTitle>
            <CardDescription>Connect your YouTube channel to enable auto-publishing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings.youtubeConnected ? (
              <>
                <div className="flex items-center justify-between p-3 border rounded-md bg-secondary/50">
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Connected channel</p>
                    <p className="font-medium text-sm">
                      {settings.youtubeChannelName ?? "YouTube Channel"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disconnectingYoutube}
                    onClick={handleDisconnectYoutube}
                  >
                    {disconnectingYoutube ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={testingYoutube}
                  onClick={handleTestYoutube}
                >
                  {testingYoutube
                    ? <><LoadingSpinner size="sm" /><span className="ml-2">Testing…</span></>
                    : "Test Connection"
                  }
                </Button>

                {youtubeTestResult && (
                  <div className={`flex items-start gap-2 text-sm p-2.5 rounded-md ${
                    youtubeTestResult.success
                      ? "bg-success/10 text-success"
                      : "bg-destructive/10 text-destructive"
                  }`}>
                    {youtubeTestResult.success
                      ? <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
                      : <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    }
                    {youtubeTestResult.message}
                  </div>
                )}
              </>
            ) : (
              <Button
                className="w-full"
                onClick={() => { window.location.href = "/api/youtube/connect"; }}
              >
                Connect YouTube Account
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Telegram Notifications */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5 text-blue-500" />
              Telegram Notifications
            </CardTitle>
            <CardDescription>Get notified when AI generation or publishing finishes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings.telegramChatId ? (
              <>
                <div className="flex items-center justify-between p-3 border rounded-md bg-secondary/50">
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Connected chat</p>
                    <p className="font-medium text-sm">@{settings.telegramChatId}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { disconnectTelegram(); setTelegramTestResult(null); }}
                  >
                    Disconnect
                  </Button>
                </div>

                <div className="flex items-center justify-between">
                  <Label>Enable Notifications</Label>
                  <Switch
                    checked={settings.notificationsEnabled}
                    onCheckedChange={(c) => updateSettings({ notificationsEnabled: c })}
                  />
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={testingTelegram}
                  onClick={handleTestTelegram}
                >
                  {testingTelegram
                    ? <><LoadingSpinner size="sm" /><span className="ml-2">Sending…</span></>
                    : "Send Test Message"
                  }
                </Button>

                {telegramTestResult && (
                  <div className={`flex items-start gap-2 text-sm p-2.5 rounded-md ${
                    telegramTestResult.success
                      ? "bg-success/10 text-success"
                      : "bg-destructive/10 text-destructive"
                  }`}>
                    {telegramTestResult.success
                      ? <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
                      : <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    }
                    {telegramTestResult.message}
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Start a chat with your bot on Telegram, then enter your chat ID below.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    placeholder="your_telegram_username"
                    value={telegramInput}
                    onChange={(e) => setTelegramInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveTelegram(); }}
                  />
                  <Button
                    disabled={!telegramInput.trim() || savingTelegram}
                    onClick={handleSaveTelegram}
                  >
                    {savingTelegram ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
