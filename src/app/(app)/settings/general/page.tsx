"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { Settings, User } from "lucide-react";
import { Loader2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import Image from "next/image";

export default function GeneralSettingsPage() {
  const user = useQuery(api.users.current);

  if (user === undefined) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Settings className="h-6 w-6 text-primary" />
          General Settings
        </h1>
        <p className="text-muted-foreground mt-1">
          Manage your account and app preferences.
        </p>
      </div>

      {/* Info card */}
      <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/30">
        <CardContent className="pt-4 pb-4">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            Your display name and profile image are managed by your Google account. Changes made there will be reflected here automatically.
          </p>
        </CardContent>
      </Card>

      {/* Account card */}
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Your account details synced from Google.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            {user?.imageUrl ? (
              <Image
                src={user.imageUrl}
                alt={user.name ?? "Profile"}
                width={56}
                height={56}
                className="rounded-full object-cover ring-2 ring-border"
              />
            ) : (
              <div className="h-14 w-14 rounded-full bg-primary/10 ring-2 ring-border flex items-center justify-center">
                <User className="h-7 w-7 text-primary" />
              </div>
            )}
            <div className="space-y-0.5">
              <p className="font-semibold text-base">{user?.name ?? "—"}</p>
              <p className="text-sm text-muted-foreground">{user?.email ?? "—"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* App Preferences, coming soon */}
      <Card>
        <CardHeader>
          <CardTitle>App Preferences</CardTitle>
          <CardDescription>Customize your Reelcast experience.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border border-dashed border-border p-6 text-center">
            <p className="text-sm text-muted-foreground">
              App preferences such as default views and display options are coming soon.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
