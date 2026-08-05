"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { HardDrive } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

const ADMIN_NAV = [
  { label: "Overview", href: "/admin" },
  { label: "Users", href: "/admin/users" },
  { label: "Quota", href: "/admin/quota" },
  { label: "Storage", href: "/admin/storage" },
  { label: "Settings", href: "/admin/settings" },
];

function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 border-b mb-8 overflow-x-auto">
      {ADMIN_NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={cn(
            "px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px",
            pathname === item.href
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export default function AdminStoragePage() {
  const stats = useQuery(api.admin.stats.getStats);
  const users = useQuery(api.admin.users.listAll, {});

  if (stats === undefined || users === undefined) {
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
        <h1 className="text-2xl font-bold">Storage</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Platform-wide file storage consumed by uploaded videos.
        </p>
      </div>

      {/* Total storage card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-muted-foreground" />
            Total Storage
          </CardTitle>
          <CardDescription>
            Summed across all videos currently stored on the platform.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-4xl font-bold">
            {formatBytes(stats.totalStorageBytes)}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Across {stats.totalVideos} video{stats.totalVideos !== 1 ? "s" : ""}{" "}
            from {users.length} user{users.length !== 1 ? "s" : ""}
          </p>
        </CardContent>
      </Card>

      {/* Info card */}
      <Card>
        <CardHeader>
          <CardTitle>Per-user Breakdown</CardTitle>
          <CardDescription>
            Storage is tracked per video file via the{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              rawFileSize
            </code>{" "}
            field. View a user&apos;s detail page to see their individual videos.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Navigate to{" "}
              <Link
                href="/admin/users"
                className="text-primary underline underline-offset-2"
              >
                Users
              </Link>{" "}
              and click &quot;View&quot; on any account to see that user&apos;s
              full video list including file sizes.
            </p>
            <p className="text-sm text-muted-foreground">
              Per-user aggregated storage totals will be available in a future
              update once a dedicated index is in place.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
