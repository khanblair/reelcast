"use client";

import Link from "next/link";
import type { Route } from "next";
import { useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
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
import { cn } from "@/lib/utils";

export default function AdminUsersPage() {
  const users = useQuery(api.admin.users.listAll, {});

  if (users === undefined) {
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
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {users.length} total accounts
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Name / Email
                  </th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Plan
                  </th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    YouTube
                  </th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Auto-publish
                  </th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Resend Key
                  </th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user._id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div>
                          <p className="font-medium truncate max-w-[180px]">
                            {user.name ?? "—"}
                          </p>
                          <p className="text-muted-foreground text-xs truncate max-w-[180px]">
                            {user.email}
                          </p>
                        </div>
                        {user.isAdmin && (
                          <Badge variant="outline" className="text-xs">
                            Admin
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
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
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-block h-2.5 w-2.5 rounded-full",
                          user.youtubeConnected ? "bg-green-500" : "bg-red-400",
                        )}
                        title={user.youtubeConnected ? "Connected" : "Not connected"}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs",
                          user.autoPublishEnabled
                            ? "border-green-500 text-green-600"
                            : "border-muted-foreground text-muted-foreground",
                        )}
                      >
                        {user.autoPublishEnabled ? "On" : "Off"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {user.hasResendApiKey ? "Set" : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/users/${user._id}` as Route}>
                        <Button size="sm" variant="outline">View</Button>
                      </Link>
                    </td>
                  </tr>
                ))}

                {users.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-muted-foreground"
                    >
                      No users found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
