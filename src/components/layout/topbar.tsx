"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { Menu, User, LogOut, BotMessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { SidebarNav } from "./sidebar";
import { NotificationsPopover } from "./notifications-popover";
import { ThemeToggle } from "@/components/theme-toggle";
import { AssistantPanel } from "@/components/ai/assistant-panel";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/utils";

function ProfileAvatar({ name, imageUrl, size = "sm" }: { name?: string | null; imageUrl?: string | null; size?: "sm" | "md" }) {
  const initials = name
    ? name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : "?";
  const dim = size === "sm" ? 32 : 40;
  const cls = size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm";

  if (imageUrl) {
    return (
      <Image
        src={imageUrl}
        alt={name ?? "Profile"}
        width={dim}
        height={dim}
        className={cn("rounded-full object-cover ring-2 ring-border", cls)}
      />
    );
  }
  return (
    <div className={cn("rounded-full bg-primary/10 ring-2 ring-border flex items-center justify-center font-semibold text-primary", cls)}>
      {initials}
    </div>
  );
}

export function Topbar() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const user = useQuery(api.users.current);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const openDropdown = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setDropdownOpen(true);
  };

  const scheduleClose = () => {
    closeTimer.current = setTimeout(() => setDropdownOpen(false), 120);
  };

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/sign-in";
  }, [router]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b bg-background px-4 md:px-6">
        <div className="flex flex-1 items-center gap-4">
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64">
              <SheetTitle className="sr-only">Navigation Menu</SheetTitle>
              <SheetDescription className="sr-only">Access all main areas of the app</SheetDescription>
              <SidebarNav onClick={() => setSheetOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAssistantOpen(true)}
            aria-label="AI Assistant"
          >
            <BotMessageSquare className="h-5 w-5" />
          </Button>
          <NotificationsPopover />

          {/* Profile dropdown */}
          <div
            ref={dropdownRef}
            className="relative"
            onMouseEnter={openDropdown}
            onMouseLeave={scheduleClose}
          >
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              className="flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Profile menu"
            >
              <ProfileAvatar name={user?.name} imageUrl={user?.imageUrl} />
            </button>

            {dropdownOpen && (
              <div
                className="absolute right-0 top-full mt-2 w-52 rounded-lg border border-border bg-popover shadow-lg z-50 overflow-hidden animate-fade-in"
                onMouseEnter={openDropdown}
                onMouseLeave={scheduleClose}
              >
                {/* User info header */}
                <div className="px-3 py-2.5 border-b border-border">
                  <p className="text-sm font-medium truncate">{user?.name ?? "Account"}</p>
                  <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
                </div>

                <div className="p-1">
                  <Link
                    href={"/profile" as Route}
                    onClick={() => setDropdownOpen(false)}
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <User className="h-4 w-4" />
                    Profile
                  </Link>

                  <button
                    onClick={() => { setDropdownOpen(false); setConfirmOpen(true); }}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} />

      {/* Sign-out confirmation dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm mx-4">
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
            <DialogDescription>
              You&apos;ll need to sign back in with Google to access your account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={signingOut}>
              Cancel
            </Button>
            <Button
              onClick={handleSignOut}
              disabled={signingOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
