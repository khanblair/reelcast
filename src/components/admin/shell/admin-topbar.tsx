"use client";

import Link from "next/link";
import type { Route } from "next";
import { Fragment, useCallback, useState } from "react";
import { ArrowLeft, ChevronRight, LogOut, Menu, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { api, useQuery } from "@/lib/rpc/client";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { isSelfLabelledGroup, resolveNavMatch } from "./nav-config";

type Crumb = { label: string; href?: string; hideOnMobile?: boolean };

function buildCrumbs(pathname: string): Crumb[] {
  const match = resolveNavMatch(pathname);
  if (!match) return [{ label: "Admin" }];
  const crumbs: Crumb[] = [];
  if (!isSelfLabelledGroup(match.group)) crumbs.push({ label: match.group.label, hideOnMobile: true });
  crumbs.push({ label: match.item.label, href: match.isDetail ? match.item.href : undefined });
  if (match.isDetail) crumbs.push({ label: "Details" });
  return crumbs;
}

function Breadcrumb({ pathname }: { pathname: string }) {
  const crumbs = buildCrumbs(pathname);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}-${index}`}>
              {index > 0 ? (
                <li aria-hidden="true" className={cn("text-muted-foreground", crumbs[index - 1].hideOnMobile && "max-sm:hidden")}>
                  <ChevronRight className="size-3.5" />
                </li>
              ) : null}
              <li className={cn("min-w-0 truncate", crumb.hideOnMobile && "max-sm:hidden")}>
                {crumb.href && !isLast ? (
                  <Link
                    href={crumb.href as Route}
                    className="rounded-sm text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span
                    aria-current={isLast ? "page" : undefined}
                    className={isLast ? "font-medium text-foreground" : "text-muted-foreground"}
                  >
                    {crumb.label}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

function initialsFor(name: string | null | undefined, email: string | null | undefined): string | null {
  const source = name?.trim() || email?.split("@")[0]?.trim();
  if (!source) return null;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

const menuItemClass =
  "flex h-9 w-full items-center gap-2 rounded-md px-3 text-sm outline-none transition-colors duration-150 hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

function UserMenu() {
  const user = useQuery(api.users.current);
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/sign-in";
  }, []);

  const initials = initialsFor(user?.name, user?.email);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="flex size-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-foreground outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          {initials ?? <User className="size-4" aria-hidden="true" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="border-b px-3 py-2.5">
          <p className="text-xs text-muted-foreground">Signed in as</p>
          {user === undefined ? (
            <Skeleton className="mt-1 h-4 w-40" />
          ) : (
            <p className="truncate text-sm font-medium">{user?.email ?? "Unknown account"}</p>
          )}
        </div>
        <div className="p-1">
          <Link href="/dashboard" className={menuItemClass}>
            <ArrowLeft className="size-4 text-muted-foreground" aria-hidden="true" />
            Back to ReelCast
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className={cn(menuItemClass, "text-muted-foreground hover:text-foreground disabled:opacity-60")}
          >
            <LogOut className="size-4" aria-hidden="true" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 56px top bar on the content surface. Must render inside the shell's `<Sheet>` (the menu button is its trigger,
 * which also gives focus back to the button when the sheet closes).
 */
export function AdminTopbar({ pathname }: { pathname: string }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 md:px-6">
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="-ml-2 md:hidden" aria-label="Open navigation menu">
          <Menu className="size-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <Breadcrumb pathname={pathname} />
      <div className="ml-auto flex items-center gap-3">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
