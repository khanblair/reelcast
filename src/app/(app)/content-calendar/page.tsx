"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { formatTimeEAT } from "@/lib/eat";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface CalendarEvent {
  videoId: string;
  title: string;
  type: "published" | "scheduled" | "auto";
  timestamp: number; // ms
}

// ─── Auto-publish estimation ─────────────────────────────────────────────────

function computeAutoEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  videos: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: any | null,
): CalendarEvent[] {
  if (!settings?.autoPublishEnabled || !settings.autoPublishNextAt) return [];
  const nextAt: number = settings.autoPublishNextAt;
  const intervalMs: number = settings.autoPublishIntervalMs ?? 6 * 3_600_000;
  const count: number = settings.autoPublishCount ?? 1;

  const readyVideos = [...videos]
    .filter((v) => v.status === "ready")
    .sort(
      (a, b) =>
        (a.publishOrder ?? 9999) - (b.publishOrder ?? 9999) ||
        a._creationTime - b._creationTime,
    );

  return readyVideos.map((v, i) => ({
    videoId: v._id,
    title: v.aiTitle ?? v.title ?? "Untitled",
    type: "auto" as const,
    timestamp: nextAt + Math.floor(i / count) * intervalMs,
  }));
}

// ─── Calendar grid builder ───────────────────────────────────────────────────

interface CalendarSlot {
  date: Date;
  dayNum: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  events: CalendarEvent[];
}

function buildGrid(
  year: number,
  month: number,
  events: CalendarEvent[],
): CalendarSlot[] {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const todayTs = todayMidnight.getTime();

  const firstOfMonth = new Date(year, month, 1);
  const startDow = (firstOfMonth.getDay() + 6) % 7; // Monday-based

  const grid: CalendarSlot[] = [];
  for (let slot = 0; slot < 42; slot++) {
    const dayOffset = slot - startDow;
    const date = new Date(year, month, 1 + dayOffset);
    date.setHours(0, 0, 0, 0);

    const dayStart = date.getTime();
    const dayEnd = dayStart + 86_400_000;

    const dayEvents = events
      .filter((e) => e.timestamp >= dayStart && e.timestamp < dayEnd)
      .sort((a, b) => a.timestamp - b.timestamp);

    grid.push({
      date,
      dayNum: date.getDate(),
      isCurrentMonth: date.getMonth() === month,
      isToday: date.getTime() === todayTs,
      events: dayEvents,
    });
  }
  return grid;
}

// ─── Event pill ──────────────────────────────────────────────────────────────

function EventPill({ event }: { event: CalendarEvent }) {
  if (event.type === "published") {
    return (
      <div className="text-[10px] truncate rounded px-1 py-0.5 bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 cursor-default leading-snug">
        {event.title}
      </div>
    );
  }
  if (event.type === "scheduled") {
    return (
      <div className="text-[10px] truncate rounded px-1 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 leading-snug">
        {formatTimeEAT(event.timestamp)} · {event.title}
      </div>
    );
  }
  // auto
  return (
    <div className="text-[10px] truncate rounded px-1 py-0.5 bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300 leading-snug">
      Auto · {formatTimeEAT(event.timestamp)}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ContentCalendarPage() {
  const allVideos = useQuery(api.videos.list);
  const settings = useQuery(api.settings.get);

  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  function goToPrevMonth() {
    setSelectedDay(null);
    if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  }

  function goToNextMonth() {
    setSelectedDay(null);
    if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  }

  function goToToday() {
    setSelectedDay(null);
    setYear(today.getFullYear());
    setMonth(today.getMonth());
  }

  // ── Flatten all events ──────────────────────────────────────────────────
  const allEvents = useMemo<CalendarEvent[]>(() => {
    if (!allVideos) return [];

    const published: CalendarEvent[] = allVideos
      .filter((v) => v.status === "published" && v.publishedAt)
      .map((v) => ({
        videoId: v._id,
        title: v.aiTitle ?? v.title ?? "Untitled",
        type: "published" as const,
        timestamp: v.publishedAt as number,
      }));

    const scheduled: CalendarEvent[] = allVideos
      .filter((v) => v.status === "scheduled" && v.scheduledPublishAt)
      .map((v) => ({
        videoId: v._id,
        title: v.aiTitle ?? v.title ?? "Untitled",
        type: "scheduled" as const,
        timestamp: v.scheduledPublishAt as number,
      }));

    const auto = computeAutoEvents(allVideos, settings ?? null);

    return [...published, ...scheduled, ...auto];
  }, [allVideos, settings]);

  const grid = useMemo(
    () => buildGrid(year, month, allEvents),
    [year, month, allEvents],
  );

  // ── Summary stats ────────────────────────────────────────────────────────
  const monthStart = new Date(year, month, 1).getTime();
  const monthEnd = new Date(year, month + 1, 1).getTime();

  const publishedThisMonth = allEvents.filter(
    (e) => e.type === "published" && e.timestamp >= monthStart && e.timestamp < monthEnd,
  ).length;

  const totalScheduled = allEvents.filter((e) => e.type === "scheduled").length;
  const totalAutoQueued = (allVideos ?? []).filter((v) => v.status === "ready").length;

  // ── Selected day detail ──────────────────────────────────────────────────
  const selectedDayEvents = useMemo<CalendarEvent[]>(() => {
    if (!selectedDay) return [];
    const dayStart = selectedDay.getTime();
    const dayEnd = dayStart + 86_400_000;
    return allEvents
      .filter((e) => e.timestamp >= dayStart && e.timestamp < dayEnd)
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [selectedDay, allEvents]);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (allVideos === undefined || settings === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const MAX_VISIBLE = 3;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5" />
          <h1 className="text-2xl font-bold">Content Calendar</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goToToday}>
            Today
          </Button>
          <Button variant="ghost" size="icon" onClick={goToPrevMonth}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Previous month</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={goToNextMonth}>
            <ChevronRight className="h-4 w-4" />
            <span className="sr-only">Next month</span>
          </Button>
          <span className="text-lg font-semibold w-36 text-center">
            {MONTH_NAMES[month]} {year}
          </span>
        </div>
      </div>

      {/* Color legend */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          Published
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-blue-500" />
          Scheduled
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-orange-400" />
          Auto-publish
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

            {/* 6 rows × 7 columns */}
            <div className="grid grid-cols-7">
              {grid.map((slot, idx) => {
                const isLastRow = idx >= 35;
                const isLastCol = (idx + 1) % 7 === 0;
                const overflow = slot.events.length - MAX_VISIBLE;
                const isSelected =
                  selectedDay?.getTime() === slot.date.getTime();

                return (
                  <div
                    key={slot.date.toISOString()}
                    onClick={() => {
                      if (!slot.isCurrentMonth) return;
                      setSelectedDay(
                        isSelected ? null : new Date(slot.date.getTime()),
                      );
                    }}
                    className={[
                      "relative flex flex-col gap-1 p-1.5 min-h-[100px]",
                      !isLastRow ? "border-b" : "",
                      !isLastCol ? "border-r" : "",
                      slot.isCurrentMonth
                        ? isSelected
                          ? "bg-accent/60 cursor-pointer"
                          : slot.events.length > 0
                          ? "cursor-pointer hover:bg-accent/30 transition-colors"
                          : ""
                        : "bg-muted/30",
                      slot.isToday && !isSelected ? "bg-primary/5" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {/* Day number */}
                    <span
                      className={[
                        "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium self-start",
                        slot.isToday
                          ? "bg-primary text-primary-foreground"
                          : slot.isCurrentMonth
                          ? "text-foreground"
                          : "text-muted-foreground/50",
                      ].join(" ")}
                    >
                      {slot.dayNum}
                    </span>

                    {/* Event pills — only for current-month days */}
                    {slot.isCurrentMonth && (
                      <div className="flex flex-col gap-0.5">
                        {slot.events.slice(0, MAX_VISIBLE).map((e, i) => (
                          <EventPill key={`${e.videoId}-${i}`} event={e} />
                        ))}
                        {overflow > 0 && (
                          <span className="px-1 text-[10px] text-muted-foreground">
                            +{overflow} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Selected day detail card */}
      {selectedDay && selectedDayEvents.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">
              {selectedDay.toLocaleDateString("en-GB", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {selectedDayEvents.map((e, i) => (
              <div
                key={`detail-${e.videoId}-${i}`}
                className="flex items-start gap-3 text-sm"
              >
                {/* Type dot */}
                <div
                  className={[
                    "mt-1 h-2 w-2 shrink-0 rounded-full",
                    e.type === "published"
                      ? "bg-green-500"
                      : e.type === "scheduled"
                      ? "bg-blue-500"
                      : "bg-orange-400",
                  ].join(" ")}
                />
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium leading-snug">{e.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {e.type === "published"
                      ? `Published · ${formatTimeEAT(e.timestamp)}`
                      : e.type === "scheduled"
                      ? `Scheduled · ${formatTimeEAT(e.timestamp)}`
                      : `Auto-publish · ${formatTimeEAT(e.timestamp)}`}
                  </p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Published this month</p>
            <p className="text-2xl font-bold mt-1">{publishedThisMonth}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Scheduled</p>
            <p className="text-2xl font-bold mt-1">{totalScheduled}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Auto-queued</p>
            <p className="text-2xl font-bold mt-1">{totalAutoQueued}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
