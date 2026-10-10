"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { api, useQuery } from "@/lib/rpc/client";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { cn } from "@/lib/utils";
import { SidebarCollapseToggle } from "@/components/layout/sidebar-collapse-toggle";
import { useSidebarCollapseBehavior } from "@/lib/use-sidebar-collapse";
import { ADMIN_NAV, isSelfLabelledGroup, resolveNavMatch, type NavItem } from "./nav-config";

/**
 * Count of payments waiting for a human. Hidden while loading and at zero, and isolated in its own error boundary
 * because a failing billing query must never take the whole console (navigation included) down with it.
 * Full width: a plain number. Icon rail (see `admin-rail:` in globals.css): a small dot on the icon (the number lives
 * in the accessible text).
 */
function NeedsReviewCount({ expanded }: { expanded: boolean }) {
  const overview = useQuery(api.admin.billing.overview);
  const count = overview?.needsReviewCount ?? 0;
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "ml-auto min-w-5 rounded-full bg-primary/15 px-1.5 text-center text-[11px] font-semibold leading-5 tabular-nums text-foreground",
          !expanded && "admin-rail:hidden",
        )}
      >
        {count > 99 ? "99+" : count}
      </span>
      {!expanded && (
        <span
          aria-hidden="true"
          className="absolute right-2 top-1.5 hidden size-2 rounded-full bg-primary admin-rail:block"
        />
      )}
      <span className="sr-only">, {count} pending</span>
    </>
  );
}

function NavLink({
  item,
  active,
  expanded,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  expanded: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href as Route}
      title={item.label}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "relative flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium outline-none transition-colors duration-150 motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        !expanded && "admin-rail:justify-center admin-rail:px-0",
        active
          ? "bg-secondary text-primary"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className={cn("truncate", !expanded && "admin-rail:sr-only")}>{item.label}</span>
      {item.badge === "needsReview" ? (
        <ErrorBoundary fallback={<></>}>
          <NeedsReviewCount expanded={expanded} />
        </ErrorBoundary>
      ) : null}
    </Link>
  );
}

/**
 * The navigation itself (brand row + grouped links). Rendered inside the desktop rail/sidebar and, with
 * `expanded`, inside the mobile sheet where labels must always be visible. `collapsible` (desktop only) adds the
 * collapse icon in the header and the expand icon in the rail.
 */
export function AdminSidebarNav({
  pathname,
  expanded = false,
  collapsible = false,
  onNavigate,
}: {
  pathname: string;
  /** Always show labels (mobile sheet). Otherwise labels collapse to the icon rail when the user collapsed the sidebar. */
  expanded?: boolean;
  /** Show the collapse/expand icons (the desktop sidebar only; the mobile sheet has none). */
  collapsible?: boolean;
  onNavigate?: () => void;
}) {
  const activeHref = resolveNavMatch(pathname)?.item.href;

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div
        className={cn(
          "flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border px-4",
          collapsible && "pr-3",
          !expanded && "admin-rail:justify-center admin-rail:px-0",
        )}
      >
        <Link
          href={"/admin" as Route}
          onClick={onNavigate}
          title="ReelCast admin"
          className="flex items-center gap-2 rounded-md text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Image src="/icons/logo.png" alt="" width={24} height={24} />
          <span className={cn("flex items-baseline gap-1.5", !expanded && "admin-rail:sr-only")}>
            ReelCast
            <span className="text-xs font-normal text-muted-foreground">Admin</span>
          </span>
        </Link>
        {collapsible ? (
          <SidebarCollapseToggle
            name="admin"
            action="collapse"
            className="size-8 shrink-0 admin-rail:hidden"
          />
        ) : null}
      </div>

      {/* Collapsed: the expand icon sits directly under the logo */}
      {collapsible ? (
        <div className="hidden shrink-0 px-2 pt-2 admin-rail:block">
          <SidebarCollapseToggle name="admin" action="expand" className="h-9 w-full" />
        </div>
      ) : null}

      <nav
        aria-label="Admin"
        className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain p-3", !expanded && "admin-rail:p-2")}
      >
        {ADMIN_NAV.map((group, index) => {
          const labelId = `admin-nav-${group.id}`;
          const showLabel = !isSelfLabelledGroup(group);
          return (
            <div key={group.id} className={cn(index > 0 && "mt-4", index > 0 && !expanded && "admin-rail:mt-2")}>
              {index > 0 && !expanded ? (
                <div aria-hidden="true" className="mb-2 hidden border-t border-sidebar-border admin-rail:block" />
              ) : null}
              {showLabel ? (
                <p
                  id={labelId}
                  className={cn("px-3 pb-1 text-xs font-medium text-muted-foreground", !expanded && "admin-rail:hidden")}
                >
                  {group.label}
                </p>
              ) : null}
              <ul aria-labelledby={showLabel ? labelId : undefined} className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <NavLink
                      item={item}
                      active={item.href === activeHref}
                      expanded={expanded}
                      onNavigate={onNavigate}
                    />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
    </div>
  );
}

/** Desktop/tablet sidebar: 240px from 768px up, collapsible to the 56px icon rail by the user, hidden below (the sheet takes over). */
export function AdminSidebar({ pathname }: { pathname: string }) {
  useSidebarCollapseBehavior("admin", 768);
  return (
    <aside className="sticky top-0 hidden h-dvh min-w-0 overflow-hidden border-r border-sidebar-border bg-sidebar md:block">
      <AdminSidebarNav pathname={pathname} collapsible />
    </aside>
  );
}
