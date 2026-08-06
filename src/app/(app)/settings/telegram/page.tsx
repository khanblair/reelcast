"use client";

import { useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { MessageCircle, Save, Loader2, CheckCircle, XCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export default function TelegramSettingsPage() {
  const settings = useQuery(api.settings.get);
  const update = useMutation(api.settings.update);
  const testTelegram = useAction(api.actions.testConnections.testTelegram);

  const [chatIdInput, setChatIdInput] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [templateInput, setTemplateInput] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savedTemplate, setSavedTemplate] = useState(false);

  const [testStatus, setTestStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [testError, setTestError] = useState<string | null>(null);

  if (settings === undefined) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const isConnected = !!settings?.telegramChatId;

  const handleConnect = async () => {
    if (!chatIdInput.trim()) return;
    setConnecting(true);
    try {
      await update({ telegramChatId: chatIdInput.trim() });
      setChatIdInput("");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await update({ telegramChatId: undefined });
    } finally {
      setDisconnecting(false);
    }
  };

  const handleTest = async () => {
    setTestStatus("loading");
    setTestError(null);
    try {
      const result = await testTelegram();
      if (result.success) {
        setTestStatus("success");
        setTimeout(() => setTestStatus("idle"), 3000);
      } else {
        setTestStatus("error");
        setTestError(result.error ?? "Test failed.");
      }
    } catch (err) {
      setTestStatus("error");
      setTestError(err instanceof Error ? err.message : "Unknown error.");
    }
  };

  const saveTemplate = async () => {
    const value = templateInput.trim();
    if (!value) return;
    setSavingTemplate(true);
    setSavedTemplate(false);
    try {
      await update({ telegramMessageTemplate: value });
      setSavedTemplate(true);
      setTimeout(() => setSavedTemplate(false), 2000);
    } finally {
      setSavingTemplate(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <MessageCircle className="h-6 w-6 text-primary" />
          Telegram Notifications
        </h1>
        <p className="text-muted-foreground mt-1">
          Connect your Telegram bot to receive publish notifications.
        </p>
      </div>

      {/* Setup instructions */}
      <Card>
        <CardHeader>
          <CardTitle>How to connect</CardTitle>
          <CardDescription>Follow these steps to set up your Telegram bot.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
            <li>Open Telegram and start a chat with <span className="font-mono text-foreground">@BotFather</span></li>
            <li>Send <span className="font-mono text-foreground">/newbot</span> and follow the prompts to create a bot</li>
            <li>Start your new bot by opening its chat and sending <span className="font-mono text-foreground">/start</span></li>
            <li>Find your Chat ID using <span className="font-mono text-foreground">@userinfobot</span>, start it and it will reply with your ID</li>
            <li>Enter your Chat ID below and click Connect</li>
          </ol>
        </CardContent>
      </Card>

      {/* Connection status */}
      <Card>
        <CardHeader>
          <CardTitle>Connection Status</CardTitle>
          <CardDescription>
            {isConnected ? "Your Telegram bot is connected." : "No Telegram bot connected yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isConnected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border bg-green-50/50 dark:bg-green-950/30 border-green-200 dark:border-green-800 p-3">
                <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-green-700 dark:text-green-300">Connected</p>
                  <p className="text-xs text-green-600/80 dark:text-green-400/80">Chat ID: {settings.telegramChatId}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={testStatus === "loading"}
                >
                  {testStatus === "loading" ? (
                    <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Testing...</>
                  ) : testStatus === "success" ? (
                    <><CheckCircle className="h-4 w-4 mr-1 text-green-600" />Sent!</>
                  ) : (
                    "Send test message"
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Disconnect"}
                </Button>
              </div>

              {testStatus === "error" && testError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  {testError}
                </div>
              )}
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                placeholder="e.g. 123456789"
                value={chatIdInput}
                onChange={(e) => setChatIdInput(e.target.value)}
                className="flex-1"
              />
              <Button
                onClick={handleConnect}
                disabled={connecting || !chatIdInput.trim()}
              >
                {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Message template */}
      <Card>
        <CardHeader>
          <CardTitle>Message Template</CardTitle>
          <CardDescription>
            Customize the format of Telegram notifications. Use{" "}
            <span className="font-mono text-foreground">{`{{title}}`}</span> and{" "}
            <span className="font-mono text-foreground">{`{{url}}`}</span> as placeholders.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-sm font-medium">Template</Label>
            <textarea
              value={templateInput || settings?.telegramMessageTemplate || ""}
              onChange={(e) => setTemplateInput(e.target.value)}
              placeholder={`Published: {{title}} | {{url}}`}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none placeholder:text-muted-foreground/60"
            />
          </div>
          <Button
            variant="outline"
            onClick={saveTemplate}
            disabled={savingTemplate || !templateInput.trim()}
          >
            {savingTemplate ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : savedTemplate ? (
              "Saved!"
            ) : (
              <>
                <Save className="h-4 w-4 mr-1" />
                Save template
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
