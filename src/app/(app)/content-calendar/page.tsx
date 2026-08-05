"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { ChevronLeft, ChevronRight, CalendarDays, Clock, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { formatTimeEAT } from "@/lib/eat";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface CalendarDay {
  date: Date;
  dayNum: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  videos: Array<{ id: string; title: string; scheduledAt: number }>;
}

function buildCalendarGrid(year: number, month: number, scheduledVideos: Array<{ _id: string; title?: string; aiTitle?: string; scheduledPublishAt?: number }>): CalendarDay[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // First day of the displayed month
  const firstOfMonth = new Date(year, month, 1);
  // Day of week for first of month (0=Sun), convert to Mon-based (0=Mon)
  const startDow = (firstOfMonth.getDay() + 6) % 7; // 0=Mon

  // Last day of the displayed month
  const lastOfMonth = new Date(year, month + 1, 0);

  // Build 42-slot grid (6 rows × 7 cols)
  const grid: CalendarDay[] = [];

  for (let slot = 0; slot < 42; slot++) {
    const dayOffset = slot - startDow;
    const date = new Date(year, month, 1 + dayOffset);
    date.setHours(0, 0, 0, 0);

    const dayStart = date.getTime();
    const dayEnd = dayStart + 86_400_000;

    const videosOnDay = (scheduledVideos ?? [])
      .filter((v) => {
        const ts = v.scheduledPublishAt;
        return ts !== undefined && ts >= dayStart && ts < dayEnd;
      })
      .map((v) => ({
        id: v._id,
        title: (v as any).aiTitle ?? v.title ?? "Untitled",
        scheduledAt: v.scheduledPublishAt as number,
      }));

    grid.push({
      date,
      dayNum: date.getDate(),
      isCurrentMonth: date.getMonth() === month,
      isToday: date.getTime() === today.getTime(),
      videos: videosOnDay,
    });
  }

  return grid;
}

export default function ContentCalendarPage() {
  const scheduledVideos = useQuery(api.videos.listScheduled);

  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-based

  const grid = useMemo(() => {
    return buildCalendarGrid(year, month, scheduledVideos ?? []);
  }, [year, month, scheduledVideos]);

  function goToPrevMonth() {
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  }

  function goToNextMonth() {
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  }

  function goToToday() {
    const now = new Date();
    setYear(now.getFullYear());
    setMonth(now.getMonth());
  }

  const isCurrentMonth =
    year === today.getFullYear() && month === today.getMonth();

  if (scheduledVideos === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-6 w-6 text-primary" />
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Content Calendar</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goToToday} disabled={isCurrentMonth}>
            Today
          </Button>
          <Button variant="outline" size="icon" onClick={goToPrevMonth}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Previous month</span>
          </Button>
          <span className="min-w-[140px] text-center font-semibold text-sm">
            {MONTH_NAMES[month]} {year}
          </span>
          <Button variant="outline" size="icon" onClick={goToNextMonth}>
            <ChevronRight className="h-4 w-4" />
            <span className="sr-only">Next month</span>
          </Button>
        </div>
      </div>

      {/* Calendar grid */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <div className="min-w-[560px]">
            {/* Day-of-week headers */}
            <div className="grid grid-cols-7 border-b">
              {DAY_LABELS.map((label) => (
                <div
                  key={label}
                  className="py-2 text-center text-xs font-semibold uppercase text-muted-foreground tracking-wide"
                >
                  {label}
                </div>
              ))}
            </div>

            {/* 6 rows of 7 days */}
            <div className="grid grid-cols-7">
              {grid.map((day, idx) => {
                const isLastRow = idx >= 35;
                const isLastCol = (idx + 1) % 7 === 0;
                const MAX_VISIBLE = 3;
                const overflow = day.videos.length - MAX_VISIBLE;

                return (
                  <div
                    key={day.date.toISOString()}
                    className={[
                      "relative flex flex-col gap-1 p-1.5 min-h-[90px]",
                      !isLastRow ? "border-b" : "",
                      !isLastCol ? "border-r" : "",
                      day.isCurrentMonth ? "" : "bg-muted/30",
                      day.isToday ? "bg-primary/5" : "",
                    ].join(" ")}
                  >
                    {/* Day number */}
                    <span
                      className={[
                        "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium self-start",
                        day.isToday
                          ? "bg-primary text-primary-foreground"
                          : day.isCurrentMonth
                          ? "text-foreground"
                          : "text-muted-foreground",
                      ].join(" ")}
                    >
                      {day.dayNum}
                    </span>

                    {/* Video pills */}
                    <div className="flex flex-col gap-0.5">
                      {day.videos.slice(0, MAX_VISIBLE).map((v) => (
                        <Link
                          key={v.id}
                          href={`/video/${v.id}`}
                          className="group flex items-center gap-1 rounded bg-primary/10 px-1 py-0.5 text-[10px] leading-snug text-primary hover:bg-primary/20 transition-colors"
                        >
                          <Clock className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{formatTimeEAT(v.scheduledAt)}</span>
                        </Link>
                      ))}
                      {overflow > 0 && (
                        <span className="px-1 text-[10px] text-muted-foreground">
                          +{overflow} more
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Legend / summary */}
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-primary/20 inline-block" />
          <span>Scheduled video</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Video className="h-3.5 w-3.5" />
          <span>
            {scheduledVideos.filter(
              (v) => v.scheduledPublishAt !== undefined && v.status === "scheduled"
            ).length}{" "}
            video{scheduledVideos.filter(
              (v) => v.scheduledPublishAt !== undefined && v.status === "scheduled"
            ).length !== 1 ? "s" : ""}{" "}
            scheduled total
          </span>
        </div>
        <Link href="/schedule" className="ml-auto text-primary hover:underline text-sm">
          Manage schedule
        </Link>
      </div>
    </div>
  );
}
