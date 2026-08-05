"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../../convex/_generated/api";
import { Id } from "../../../../../../convex/_generated/dataModel";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
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
            pathname.startsWith(item.href) && item.href !== "/admin"
              ? "border-primary text-primary"
              : pathname === item.href
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

function formatDate(ms: number | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export default function AdminUserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const data = useQuery(api.admin.users.getWithDetails, {
    userId: userId as Id<"users">,
  });

  const setAdmin = useMutation(api.admin.users.setAdmin);
  const setPlan = useMutation(api.admin.users.setPlan);

  if (data === undefined) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <div className="flex h-64 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="max-w-6xl mx-auto space-y-8">
        <AdminNav />
        <p className="text-muted-foreground">User not found.</p>
      </div>
    );
  }

  const { user, videos, recentJobs } = data;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <AdminNav />

      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/admin/users">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Users
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">{user.name ?? user.email}</h1>
        {user.isAdmin && (
          <Badge variant="outline">Admin</Badge>
        )}
      </div>

      {/* User Info Card */}
      <Card>
        <CardHeader>
          <CardTitle>Account Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32">Email</span>
            <span>{user.email}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32">Name</span>
            <span>{user.name ?? "—"}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32">Plan</span>
            <Badge
              className={cn(
                "text-xs",
                user.plan === "pro"
                  ? "bg-blue-500 text-white hover:bg-blue-600"
                  : "bg-muted text-muted-foreground hover:bg-muted",
              )}
            >
              {user.plan ?? "free"}
            </Badge>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32">YouTube</span>
            <span>
              {user.youtubeConnected
                ? `Connected (${user.youtubeOAuthStatus ?? "ok"})`
                : "Not connected"}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-32">Member since</span>
            <span>{formatDate(user._creationTime)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Plan Control */}
      <Card>
        <CardHeader>
          <CardTitle>Plan</CardTitle>
          <CardDescription>Upgrade or downgrade this user&apos;s plan.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button
            variant={user.plan === "free" ? "default" : "outline"}
            size="sm"
            onClick={() =>
              setPlan({ userId: userId as Id<"users">, plan: "free" })
            }
          >
            Free
          </Button>
          <Button
            variant={user.plan === "pro" ? "default" : "outline"}
            size="sm"
            onClick={() =>
              setPlan({ userId: userId as Id<"users">, plan: "pro" })
            }
          >
            Pro
          </Button>
        </CardContent>
      </Card>

      {/* Admin Toggle */}
      <Card>
        <CardHeader>
          <CardTitle>Admin Access</CardTitle>
          <CardDescription>
            Grant or revoke admin privileges for this user.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button
            variant={user.isAdmin ? "destructive" : "outline"}
            size="sm"
            onClick={() =>
              setAdmin({
                userId: userId as Id<"users">,
                isAdmin: !user.isAdmin,
              })
            }
          >
            {user.isAdmin ? "Revoke Admin" : "Grant Admin"}
          </Button>
        </CardContent>
      </Card>

      {/* Recent Videos */}
      <Card>
        <CardHeader>
          <CardTitle>Videos ({videos.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {videos.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">
              No videos yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Title
                    </th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Published At
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr key={v._id} className="border-b last:border-0">
                      <td className="px-4 py-2 truncate max-w-[240px]">
                        {v.title ?? "Untitled"}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-xs capitalize">
                          {v.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {v.status === "published"
                          ? formatDate(v.publishedAt)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent Jobs */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Jobs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recentJobs.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">
              No jobs yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Type
                    </th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="px-4 py-3 font-medium text-muted-foreground">
                      Started At
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recentJobs.map((j) => (
                    <tr key={j._id} className="border-b last:border-0">
                      <td className="px-4 py-2 capitalize">{j.type}</td>
                      <td className="px-4 py-2">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-xs capitalize",
                            j.status === "completed" &&
                              "border-green-500 text-green-600",
                            j.status === "failed" &&
                              "border-red-500 text-red-600",
                          )}
                        >
                          {j.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatDate(j.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
