"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import {
  Users,
  Youtube,
  Video,
  CheckCircle,
  Activity,
  Zap,
  HardDrive,
  TrendingUp,
  ArrowRight,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
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

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}

function StatCard({ icon, label, value }: StatCardProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className="text-muted-foreground">{icon}</div>
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const ACTION_CARDS = [
  {
    href: "/admin/users",
    title: "Manage Users",
    description: "View plans, YouTube connections, and admin roles.",
  },
  {
    href: "/admin/quota",
    title: "YouTube Quota",
    description: "Monitor daily API quota usage across all users.",
  },
  {
    href: "/admin/storage",
    title: "Storage",
    description: "Total storage consumed across all uploaded videos.",
  },
];

export default function AdminOverviewPage() {
  const stats = useQuery(api.admin.stats.getStats);

  if (stats === undefined) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  const successLabel =
    stats.successRate24h === null
      ? "N/A"
      : `${Math.round(stats.successRate24h * 100)}%`;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Admin Overview</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Platform-wide metrics at a glance.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          icon={<Users className="h-5 w-5" />}
          label="Total Users"
          value={stats.totalUsers}
        />
        <StatCard
          icon={<Youtube className="h-5 w-5" />}
          label="YouTube Connected"
          value={stats.youtubeConnected}
        />
        <StatCard
          icon={<Video className="h-5 w-5" />}
          label="Total Videos"
          value={stats.totalVideos}
        />
        <StatCard
          icon={<CheckCircle className="h-5 w-5" />}
          label="Published Videos"
          value={stats.publishedVideos}
        />
        <StatCard
          icon={<Activity className="h-5 w-5" />}
          label="Jobs Today"
          value={stats.jobsToday}
        />
        <StatCard
          icon={<Zap className="h-5 w-5" />}
          label="Auto-publish Active"
          value={stats.autoPublishActive}
        />
        <StatCard
          icon={<HardDrive className="h-5 w-5" />}
          label="Total Storage"
          value={formatBytes(stats.totalStorageBytes)}
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="Success Rate 24h"
          value={successLabel}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {ACTION_CARDS.map((card) => (
          <Link key={card.href} href={card.href}>
            <Card className="h-full hover:bg-muted/50 transition-colors cursor-pointer">
              <CardHeader>
                <CardTitle className="text-base flex items-center justify-between">
                  {card.title}
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </CardTitle>
                <CardDescription>{card.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
