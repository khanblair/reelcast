"use client";

import { ArrowLeftToLine, ArrowRightToLine } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SidebarName } from "@/lib/sidebar-collapse";
import { setSidebarCollapsed } from "@/lib/use-sidebar-collapse";

/**
 * Icon-only button that collapses or expands a desktop sidebar.
 *
 * Each sidebar renders two of them and CSS shows one: "collapse" in the header, to the right of the logo (visible
 * while the sidebar is open), and "expand" under the logo in the icon rail (visible while it is collapsed). The
 * parent passes the sizing and the visibility classes, because the `app-rail:` / `admin-rail:` variants are literal
 * class names. The button keeps no state, so it can never disagree with what is on screen.
 */
export function SidebarCollapseToggle({
  name,
  action,
  className,
}: {
  name: SidebarName;
  action: "collapse" | "expand";
  className?: string;
}) {
  const collapse = action === "collapse";
  const label = collapse ? "Collapse sidebar" : "Expand sidebar";
  const Icon = collapse ? ArrowLeftToLine : ArrowRightToLine;

  return (
    <button
      type="button"
      onClick={() => setSidebarCollapsed(name, collapse)}
      aria-label={label}
      title={`${label} (Ctrl/⌘ + B)`}
      className={cn(
        "flex items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-150",
        "hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        className,
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}
