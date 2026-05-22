"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Upload,
  Files,
  Calendar,
  History,
  BarChart,
  Settings,
  Video,
  Wand2,
} from "lucide-react";

const NAV_ITEMS = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Upload", href: "/upload", icon: Upload },
  { name: "Drafts", href: "/drafts", icon: Files },
  { name: "Schedule", href: "/schedule", icon: Calendar },
  { name: "History", href: "/history", icon: History },
  { name: "Analytics", href: "/analytics", icon: BarChart },
  { name: "AI Config", href: "/ai-config", icon: Wand2 },
];

export function SidebarNav({ onClick }: { onClick?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* Logo */}
      <div className="flex h-16 items-center border-b px-6">
        <Link href="/dashboard" className="flex items-center gap-2 font-bold text-lg" onClick={onClick}>
          <Video className="h-6 w-6 text-primary" />
          <span>ReelCast</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto p-4">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href as any}
              onClick={onClick}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-secondary text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Settings */}
      <div className="border-t p-4">
        <Link
          href={"/settings" as any}
          onClick={onClick}
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            pathname.startsWith("/settings")
              ? "bg-secondary text-primary"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground"
          )}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="fixed left-0 top-0 z-40 hidden md:block h-screen w-64 border-r bg-sidebar transition-transform">
      <SidebarNav />
    </aside>
  );
}
