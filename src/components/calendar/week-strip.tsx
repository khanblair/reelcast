"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface DaySlot {
  date: Date;
  label: string;       // "Mon", "Tue", etc.
  dayNum: number;      // 1–31
  isToday: boolean;
  videoCount: number;
}

interface WeekStripProps {
  // Array of scheduledPublishAt timestamps (ms) for the user's scheduled videos
  scheduledTimestamps: number[];
}

export function WeekStrip({ scheduledTimestamps }: WeekStripProps) {
  const days = useMemo<DaySlot[]>(() => {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=Sun
    // Start from Monday
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((dayOfWeek + 6) % 7));
    monday.setHours(0, 0, 0, 0);

    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      const dayStart = date.getTime();
      const dayEnd = dayStart + 86_400_000;
      return {
        date,
        label: date.toLocaleDateString("en-US", { weekday: "short" }),
        dayNum: date.getDate(),
        isToday: date.toDateString() === today.toDateString(),
        videoCount: scheduledTimestamps.filter((ts) => ts >= dayStart && ts < dayEnd).length,
      };
    });
  }, [scheduledTimestamps]);

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {days.map((day) => (
        <div
          key={day.date.toISOString()}
          className={cn(
            "flex min-w-[60px] flex-col items-center rounded-lg border p-2 text-center text-sm transition-colors",
            day.isToday
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-card hover:bg-accent"
          )}
        >
          <span className="text-xs font-medium uppercase text-muted-foreground">{day.label}</span>
          <span className="text-lg font-semibold leading-tight">{day.dayNum}</span>
          {day.videoCount > 0 && (
            <span className="mt-1 rounded-full bg-primary/20 px-1.5 py-0.5 text-xs font-medium text-primary">
              {day.videoCount}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
