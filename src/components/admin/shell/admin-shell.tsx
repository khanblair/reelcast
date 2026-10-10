"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { AdminSidebar, AdminSidebarNav } from "./admin-sidebar";
import { AdminTopbar } from "./admin-topbar";

/**
 * Chrome for the whole admin console: skip link, sidebar (240px / 56px icon rail / off-canvas sheet), top bar and
 * the main landmark. Owns the mobile sheet state and the responsive grid. From 768px the user can collapse the
 * sidebar to the rail; that preference is an <html> attribute followed in CSS (see src/lib/sidebar-collapse.ts).
 *
 * `pathnameOverride` replaces `usePathname()` for active-item highlighting and the breadcrumb (used to preview
 * the shell on a route that is not under /admin). Leave it unset in the real layout.
 */
export function AdminShell({ children, pathnameOverride }: { children: ReactNode; pathnameOverride?: string }) {
  const livePathname = usePathname();
  const pathname = pathnameOverride ?? livePathname;
  const [sheetOpen, setSheetOpen] = useState(false);

  // The sheet is a phone-only affordance: if the viewport grows past 768px while it is open, close it.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setSheetOpen(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return (
    <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <div className="grid min-h-dvh grid-cols-1 bg-background transition-[grid-template-columns] duration-200 ease-out motion-reduce:transition-none md:grid-cols-[240px_minmax(0,1fr)] md:admin-rail:grid-cols-[56px_minmax(0,1fr)]">
        <AdminSidebar pathname={pathname} />
        <div className="flex min-w-0 flex-col">
          <AdminTopbar pathname={pathname} />
          <main id="admin-main" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-6">
            {children}
          </main>
        </div>
      </div>

      <SheetContent side="left" className="w-64 p-0 motion-reduce:animate-none! motion-reduce:transition-none">
        <SheetTitle className="sr-only">Admin navigation</SheetTitle>
        <SheetDescription className="sr-only">Move between the sections of the admin console.</SheetDescription>
        <AdminSidebarNav pathname={pathname} expanded onNavigate={() => setSheetOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
