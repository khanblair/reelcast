"use client";

import { UserButton } from "@clerk/nextjs";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { SidebarNav } from "./sidebar";
import { NotificationsPopover } from "./notifications-popover";
import { useState } from "react";

export function Topbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b bg-background px-6">
      <div className="flex flex-1 items-center gap-4">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="md:hidden">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0 w-64">
            <SheetTitle className="sr-only">Navigation Menu</SheetTitle>
            <SheetDescription className="sr-only">Access all main areas of the app</SheetDescription>
            <SidebarNav onClick={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        {/* Placeholder for Breadcrumbs or Search */}
      </div>

      <div className="flex items-center gap-4">
        <NotificationsPopover />
        <UserButton />
      </div>
    </header>
  );
}
