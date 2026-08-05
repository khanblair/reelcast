"use client";

import Link from "next/link";
import { Info } from "lucide-react";
import { AdminNav } from "@/components/admin/admin-nav";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

const ENV_VARS = [
  {
    name: "NEXT_PUBLIC_APP_URL",
    purpose: "Public base URL of the app (used in OAuth callbacks and emails).",
  },
  {
    name: "CONVEX_DEPLOYMENT",
    purpose: "Convex deployment name — set automatically by `npx convex dev`.",
  },
  {
    name: "NEXT_PUBLIC_CONVEX_URL",
    purpose: "Public Convex HTTPS URL used by the client.",
  },
  {
    name: "GOOGLE_CLIENT_ID",
    purpose: "YouTube OAuth 2.0 client ID from Google Cloud Console.",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    purpose: "YouTube OAuth 2.0 client secret from Google Cloud Console.",
  },
  {
    name: "CLERK_SECRET_KEY",
    purpose: "Server-side Clerk secret key for authentication.",
  },
  {
    name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    purpose: "Public Clerk key used by the browser client.",
  },
];

export default function AdminSettingsPage() {
  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Platform Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Read-only overview of platform configuration.
        </p>
      </div>

      {/* Platform Info */}
      <Card>
        <CardHeader>
          <CardTitle>Platform Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-40">Platform name</span>
            <span className="font-medium">Reelcast</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-40">App URL</span>
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
              NEXT_PUBLIC_APP_URL
            </code>
          </div>
        </CardContent>
      </Card>

      {/* Notes */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Info className="h-4 w-4 text-muted-foreground" />
            Configuration Notes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Per-user AI and notification settings are managed by each user on
            their own{" "}
            <Link
              href="/settings"
              className="text-primary underline underline-offset-2"
            >
              Settings
            </Link>{" "}
            page.
          </p>
          <p>
            YouTube OAuth credentials (client ID and secret) are configured via
            environment variables and are never stored in the database.
          </p>
          <p>
            To change platform-level configuration, update the relevant
            environment variables in your deployment environment (Vercel, Railway,
            etc.) and redeploy.
          </p>
        </CardContent>
      </Card>

      {/* Required env vars */}
      <Card>
        <CardHeader>
          <CardTitle>Required Environment Variables</CardTitle>
          <CardDescription>
            These variables must be set for the platform to function correctly.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Variable
                  </th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Purpose
                  </th>
                </tr>
              </thead>
              <tbody>
                {ENV_VARS.map((v) => (
                  <tr key={v.name} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                        {v.name}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {v.purpose}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
