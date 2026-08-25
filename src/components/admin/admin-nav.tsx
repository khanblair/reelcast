"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Route } from "next";

const ADMIN_TABS = [
  { label: "Overview",  href: "/admin" },
  { label: "Users",     href: "/admin/users" },
  { label: "Videos",    href: "/admin/videos" },
  { label: "Jobs",      href: "/admin/jobs" },
  { label: "Quota",     href: "/admin/quota" },
  { label: "Storage",   href: "/admin/storage" },
  { label: "Health",    href: "/admin/health" },
  { label: "Usage",     href: "/admin/usage" },
  { label: "Settings",  href: "/admin/settings" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 overflow-x-auto border-b pb-0 mb-6">
      {ADMIN_TABS.map((tab) => {
        const isActive =
          tab.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href as Route}
            className={cn(
              "whitespace-nowrap rounded-t-md px-4 py-2 text-sm font-medium transition-colors border-b-2",
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
