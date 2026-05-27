"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  if (!mounted) return <div className="w-14 sm:w-16 h-8" />;

  const isDark = theme === "dark" || (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative inline-flex h-8 w-14 sm:w-16 items-center rounded-full bg-secondary/80 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border shadow-inner"
    >
      <span className="sr-only">Toggle theme</span>
      
      <div className="flex w-full justify-between px-2 sm:px-2.5 absolute inset-0 items-center pointer-events-none">
        <Sun className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
        <Moon className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
      </div>

      <div
        className={cn(
          "absolute left-0.5 h-5 w-5 sm:h-6 sm:w-6 rounded-full bg-background shadow-md transition-transform pointer-events-none",
          isDark ? "translate-x-7 sm:translate-x-8" : "translate-x-0"
        )}
      />
    </button>
  );
}
