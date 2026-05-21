"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return <div className="w-16 h-8" />;

  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative inline-flex h-8 w-16 items-center rounded-full bg-secondary/80 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border shadow-inner"
    >
      <span className="sr-only">Toggle theme</span>
      
      {/* Background icons */}
      <div className="flex w-full justify-between px-2.5 absolute inset-0 items-center pointer-events-none">
        <Sun className="h-4 w-4 text-muted-foreground" />
        <Moon className="h-4 w-4 text-muted-foreground" />
      </div>

      {/* Sliding thumb */}
      <div
        className={cn(
          "absolute left-1 h-6 w-6 rounded-full bg-background shadow-md transition-transform pointer-events-none",
          isDark ? "translate-x-8" : "translate-x-0"
        )}
      />
    </button>
  );
}
