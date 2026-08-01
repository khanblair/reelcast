"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Youtube, MessageCircle, CheckCircle, XCircle, Settings, Sparkles } from "lucide-react";
import { AISettingsModal } from "@/components/settings/ai-settings-modal";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

type TestResult = { success: boolean; message: string } | null;

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.02.012.04.028.054a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

export default function SettingsPage() {
  const [youtubeBanner, setYoutubeBanner] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const yt = params.get("youtube");
    if (yt === "connected") {
      setYoutubeBanner({ success: true, message: "YouTube connected successfully!" });
    } else if (yt === "error") {
      const reason = params.get("reason") ?? "unknown";
      setYoutubeBanner({ success: false, message: `YouTube connection failed (${reason}). Please try again.` });
    }
  }, []);

  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);
  const disconnectYoutube = useMutation(api.users.disconnectYoutube);
  const disconnectTelegram = useMutation(api.settings.disconnectTelegram);
  const disconnectDiscord = useMutation(api.settings.disconnectDiscord);
  const testYoutube = useAction(api.actions.testConnections.testYoutube);
  const testTelegram = useAction(api.actions.testConnections.testTelegram);
  const testDiscord = useAction(api.actions.testConnections.testDiscord);

  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [telegramInput, setTelegramInput] = useState("");
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [discordInput, setDiscordInput] = useState("");
  const [savingDiscord, setSavingDiscord] = useState(false);
  const [disconnectingYoutube, setDisconnectingYoutube] = useState(false);
  const [testingYoutube, setTestingYoutube] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [testingDiscord, setTestingDiscord] = useState(false);
  const [youtubeTestResult, setYoutubeTestResult] = useState<TestResult>(null);
  const [telegramTestResult, setTelegramTestResult] = useState<TestResult>(null);
  const [discordTestResult, setDiscordTestResult] = useState<TestResult>(null);

  if (settings === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
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

  const handleSaveDiscord = async () => {
    const value = discordInput.trim();
    if (!value) return;
    setSavingDiscord(true);
    try {
      await updateSettings({ discordWebhookUrl: value });
      setDiscordInput("");
    } finally {
      setSavingDiscord(false);
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
      setYoutubeTestResult({
        success: false,
        message: e instanceof Error ? e.message : "Unknown error.",
      });
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
      setTelegramTestResult({
        success: false,
        message: e instanceof Error ? e.message : "Unknown error.",
      });
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleTestDiscord = async () => {
    setTestingDiscord(true);
    setDiscordTestResult(null);
    try {
      const result = await testDiscord({});
      setDiscordTestResult(
        result.success
          ? { success: true, message: "Test message sent! Check your Discord channel." }
          : { success: false, message: result.error ?? "Connection failed." }
      );
    } catch (e) {
      setDiscordTestResult({
        success: false,
        message: e instanceof Error ? e.message : "Unknown error.",
      });
    } finally {
      setTestingDiscord(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">Settings</h1>
        <p className="text-muted-foreground">
          Manage your connections, notifications, and default preferences.
        </p>
      </div>

      {/* AI Settings */}
      <button type="button" onClick={() => setAiModalOpen(true)} className="w-full text-left group">
        <Card className="transition-colors hover:border-primary/40 hover:bg-muted/30">
          <CardContent className="flex items-center gap-4 py-4 px-5">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 ring-1 ring-primary/20 shrink-0">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">AI Settings</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Metadata tone, language, channel guidelines, Veo model defaults
              </p>
            </div>
            <span className="text-xs text-primary font-medium group-hover:underline shrink-0">Configure →</span>
          </CardContent>
        </Card>
      </button>
      <AISettingsModal open={aiModalOpen} onClose={() => setAiModalOpen(false)} />

      <div className="grid gap-6 md:grid-cols-2">
        {/* YouTube Connection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Youtube className="h-5 w-5 text-primary" />
              YouTube Connection
            </CardTitle>
            <CardDescription>
              Connect your YouTube channel to enable auto-publishing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {youtubeBanner && (
              <TestResultBanner result={youtubeBanner} />
            )}
            {settings.youtubeConnected ? (
              <>
                <div className="flex items-center justify-between gap-3 p-3 border rounded-md bg-secondary/50">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground mb-0.5">Connected channel</p>
                    <p className="font-medium text-sm truncate">
                      {settings.youtubeChannelName ?? "YouTube Channel"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
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
                  {testingYoutube ? (
                    <><LoadingSpinner size="sm" /><span className="ml-2">Testing…</span></>
                  ) : (
                    "Test Connection"
                  )}
                </Button>

                {youtubeTestResult && (
                  <TestResultBanner result={youtubeTestResult} />
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
            <CardDescription>
              Get notified when AI generation or publishing finishes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings.telegramChatId ? (
              <>
                <div className="flex items-center justify-between gap-3 p-3 border rounded-md bg-secondary/50">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground mb-0.5">Connected chat</p>
                    <p className="font-medium text-sm truncate">@{settings.telegramChatId}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      disconnectTelegram();
                      setTelegramTestResult(null);
                    }}
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
                  {testingTelegram ? (
                    <><LoadingSpinner size="sm" /><span className="ml-2">Sending…</span></>
                  ) : (
                    "Send Test Message"
                  )}
                </Button>

                {telegramTestResult && (
                  <TestResultBanner result={telegramTestResult} />
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

        {/* Discord Notifications */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DiscordIcon className="h-5 w-5 text-[#5865F2]" />
              Discord Notifications
            </CardTitle>
            <CardDescription>
              Post notifications to a Discord channel via a webhook.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(settings as any).discordWebhookUrl ? (
              <>
                <div className="flex items-center justify-between gap-3 p-3 border rounded-md bg-secondary/50">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground mb-0.5">Webhook status</p>
                    <p className="font-medium text-sm flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      Connected
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      disconnectDiscord();
                      setDiscordTestResult(null);
                    }}
                  >
                    Disconnect
                  </Button>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={testingDiscord}
                  onClick={handleTestDiscord}
                >
                  {testingDiscord ? (
                    <><LoadingSpinner size="sm" /><span className="ml-2">Sending…</span></>
                  ) : (
                    "Send Test Message"
                  )}
                </Button>

                {discordTestResult && (
                  <TestResultBanner result={discordTestResult} />
                )}
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  In Discord, go to your channel → Edit → Integrations → Webhooks → New Webhook,
                  then copy the webhook URL and paste it below.
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    type="password"
                    placeholder="https://discord.com/api/webhooks/…"
                    value={discordInput}
                    onChange={(e) => setDiscordInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSaveDiscord(); }}
                    autoComplete="off"
                  />
                  <Button
                    disabled={!discordInput.trim() || savingDiscord}
                    onClick={handleSaveDiscord}
                  >
                    {savingDiscord ? "Saving…" : "Save"}
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

function TestResultBanner({ result }: { result: { success: boolean; message: string } }) {
  return (
    <div
      className={`flex items-start gap-2 text-sm p-2.5 rounded-md ${
        result.success
          ? "bg-success/10 text-success"
          : "bg-destructive/10 text-destructive"
      }`}
    >
      {result.success
        ? <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
        : <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
      }
      {result.message}
    </div>
  );
}
