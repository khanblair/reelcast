"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Youtube, MessageCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";

export default function SettingsPage() {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);
  const disconnectYoutube = useMutation(api.users.disconnectYoutube);
  const disconnectTelegram = useMutation(api.settings.disconnectTelegram);

  const [telegramInput, setTelegramInput] = useState("");
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [disconnectingYoutube, setDisconnectingYoutube] = useState(false);

  if (settings === undefined) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  if (settings === null) {
    return <div className="flex h-[80vh] items-center justify-center text-muted-foreground">User settings not found.</div>;
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
    try {
      await disconnectYoutube();
    } finally {
      setDisconnectingYoutube(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Settings</h1>
        <p className="text-muted-foreground">Manage your connections, notifications, and default preferences.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* YouTube Connection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Youtube className="h-5 w-5 text-red-500" />
              YouTube Connection
            </CardTitle>
            <CardDescription>Connect your YouTube channel to enable auto-publishing.</CardDescription>
          </CardHeader>
          <CardContent>
            {settings.youtubeConnected ? (
              <div className="space-y-4">
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
              </div>
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
          <CardContent>
            {settings.telegramChatId ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-3 border rounded-md bg-secondary/50">
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">Connected chat</p>
                    <p className="font-medium text-sm">@{settings.telegramChatId}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => disconnectTelegram()}
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
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Start a chat with your bot on Telegram, then enter your username below.
                </p>
                <div className="flex gap-2">
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
