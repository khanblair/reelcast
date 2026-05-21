"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Settings, Youtube, MessageCircle, Save } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { AI_PRESETS } from "@/lib/constants";

export default function SettingsPage() {
  const settings = useQuery(api.settings.get);
  const updateSettings = useMutation(api.settings.update);

  if (settings === undefined) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  if (settings === null) {
    return <div className="flex h-[80vh] items-center justify-center text-muted-foreground">User settings not found.</div>;
  }

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
              <div className="flex items-center justify-between p-3 border rounded-md bg-secondary/50">
                <span className="font-medium text-sm">Connected as Channel ID</span>
                <Button variant="outline" size="sm">Disconnect</Button>
              </div>
            ) : (
              <Button className="w-full">Connect YouTube Account</Button>
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
                  <span className="font-medium text-sm">Connected to @{settings.telegramChatId}</span>
                  <Button variant="outline" size="sm">Disconnect</Button>
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
              <Button variant="outline" className="w-full border-blue-500 text-blue-500 hover:bg-blue-500/10">
                Connect Telegram Bot
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Default AI Settings */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" />
              Default AI Preferences
            </CardTitle>
            <CardDescription>These settings will be applied by default to all new uploads.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 max-w-sm">
              <Label>Default Generation Style</Label>
              <Select 
                defaultValue={settings.aiPreset}
                onChange={(e: any) => updateSettings({ aiPreset: e.target.value })}
              >
                {AI_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </Select>
            </div>
            
            <div className="flex items-center justify-between max-w-sm pt-2">
              <div className="space-y-0.5">
                <Label>Auto-generate Tags</Label>
                <p className="text-sm text-muted-foreground">Always include tags</p>
              </div>
              <Switch defaultChecked />
            </div>
          </CardContent>
          <CardFooter>
            <Button variant="secondary"><Save className="mr-2 h-4 w-4" /> Save Preferences</Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
