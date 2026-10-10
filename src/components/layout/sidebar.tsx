"use client";

import Link from "next/link";
import Image from "next/image";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { api, useQuery } from "@/lib/rpc/client";
import { cn } from "@/lib/utils";
import { useSidebarCollapseBehavior } from "@/lib/use-sidebar-collapse";
import { SidebarCollapseToggle } from "./sidebar-collapse-toggle";
import {
  LayoutDashboard,
  Upload,
  Files,
  Calendar,
  CalendarDays,
  History,
  BarChart,
  Settings,
  Sparkles,
  ListOrdered,
  TrendingUp,
  Lightbulb,
  ShieldCheck,
  CreditCard,
  User,
} from "lucide-react";

const NAV_ITEMS = [
  { name: "Dashboard",    href: "/dashboard",       icon: LayoutDashboard },
  { name: "Generate",     href: "/generate",         icon: Sparkles },
  { name: "Upload",       href: "/upload",           icon: Upload },
  { name: "Library",      href: "/drafts",           icon: Files },
  { name: "Queue",        href: "/queue",            icon: ListOrdered },
  { name: "Schedule",     href: "/schedule",         icon: Calendar },
  { name: "Calendar",     href: "/content-calendar", icon: CalendarDays },
  { name: "Intelligence", href: "/intelligence",     icon: TrendingUp },
  { name: "Ideas",        href: "/ideas",            icon: Lightbulb },
  { name: "History",      href: "/history",          icon: History },
  { name: "Analytics",    href: "/analytics",        icon: BarChart },
  { name: "Billing",      href: "/billing",          icon: CreditCard },
  { name: "Profile",      href: "/profile",          icon: User },
];

function navItemClass(isActive: boolean, collapsible: boolean) {
  return cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
    collapsible && "app-rail:justify-center app-rail:px-0",
    isActive ? "bg-secondary text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
  );
}

/**
 * The navigation. `collapsible` is set only for the desktop sidebar: it adds the icon-rail styles (driven by the
 * `app-rail:` variant) and the collapse/expand icon buttons. The mobile sheet renders it without, so it always shows
 * labels and has no toggle.
 */
export function SidebarNav({ onClick, collapsible = false }: { onClick?: () => void; collapsible?: boolean }) {
  const pathname = usePathname();
  const user = useQuery(api.users.current);
  // In the rail the label is screen-reader-only, and a native tooltip names the icon on hover.
  const labelClass = cn(collapsible && "app-rail:sr-only");
  return (
    <div className="flex h-full flex-col bg-sidebar">
      {/* Logo, with the collapse icon at the right (hidden in the rail, which has no room beside the logo) */}
      <div
        className={cn(
          "flex h-16 items-center justify-between border-b px-6",
          collapsible && "pr-3 app-rail:justify-center app-rail:px-0",
        )}
      >
        <Link href="/dashboard" className="flex items-center gap-2 font-bold text-lg" onClick={onClick}>
          <Image src="/icons/logo.png" alt="ReelCast" width={24} height={24} />
          <span className={labelClass}>ReelCast</span>
        </Link>
        {collapsible && <SidebarCollapseToggle name="app" action="collapse" className="size-8 shrink-0 app-rail:hidden" />}
      </div>

      {/* In the rail the expand icon sits directly under the logo */}
      {collapsible && (
        <div className="hidden px-2 pt-2 app-rail:block">
          <SidebarCollapseToggle name="app" action="expand" className="h-9 w-full" />
        </div>
      )}

      {/* Navigation */}
      <nav className={cn("flex-1 space-y-1 overflow-y-auto p-4", collapsible && "app-rail:p-2")}>
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href as Route}
              title={collapsible ? item.name : undefined}
              onClick={onClick}
              className={navItemClass(isActive, collapsible)}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              <span className={labelClass}>{item.name}</span>
            </Link>
          );
        })}
      </nav>

      {/* Settings */}
      <div className={cn("space-y-1 border-t p-4", collapsible && "app-rail:p-2")}>
        <Link
          href="/settings"
          title={collapsible ? "Settings" : undefined}
          onClick={onClick}
          className={navItemClass(pathname.startsWith("/settings"), collapsible)}
        >
          <Settings className="h-4 w-4 shrink-0" />
          <span className={labelClass}>Settings</span>
        </Link>
        {user?.isAdmin && (
          <Link
            href={"/admin" as Route}
            title={collapsible ? "Admin" : undefined}
            onClick={onClick}
            className={navItemClass(pathname.startsWith("/admin"), collapsible)}
          >
            <ShieldCheck className="h-4 w-4 shrink-0" />
            <span className={labelClass}>Admin</span>
          </Link>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  useSidebarCollapseBehavior("app", 768);
  return (
    <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 overflow-hidden border-r bg-sidebar transition-[width] duration-200 ease-out motion-reduce:transition-none md:block app-rail:w-14">
      <SidebarNav collapsible />
    </aside>
  );
}
