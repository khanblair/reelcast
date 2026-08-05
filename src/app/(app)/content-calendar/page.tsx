"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { formatTimeEAT, formatDateTimeEAT } from "@/lib/eat";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
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

// ─── Month grid ──────────────────────────────────────────────────────────────

function MonthGrid({
  grid,
  selectedDay,
  onSelectDay,
}: {
  grid: CalendarSlot[];
  selectedDay: Date | null;
  onSelectDay: (d: Date) => void;
}) {
  const MAX_VISIBLE = 3;

  return (
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
                selectedDay?.toDateString() === slot.date.toDateString();

              return (
                <div
                  key={slot.date.toISOString()}
                  onClick={() => {
                    if (!slot.isCurrentMonth) return;
                    onSelectDay(slot.date);
                  }}
                  className={cn(
                    "relative flex flex-col gap-1 p-1.5 min-h-[100px]",
                    !isLastRow && "border-b",
                    !isLastCol && "border-r",
                    slot.isCurrentMonth
                      ? isSelected
                        ? "bg-accent/60 cursor-pointer"
                        : "cursor-pointer hover:bg-accent/30 transition-colors"
                      : "bg-muted/30",
                    slot.isToday && !isSelected && "bg-primary/5",
                  )}
                >
                  {/* Day number */}
                  <span
                    className={cn(
                      "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium self-start",
                      slot.isToday
                        ? "bg-primary text-primary-foreground"
                        : slot.isCurrentMonth
                        ? "text-foreground"
                        : "text-muted-foreground/50",
                    )}
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
  );
}

// ─── Week grid ───────────────────────────────────────────────────────────────

function WeekGrid({
  weekStart,
  events,
  selectedDay,
  onSelectDay,
}: {
  weekStart: Date;
  events: CalendarEvent[];
  selectedDay: Date | null;
  onSelectDay: (d: Date) => void;
}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  return (
    <div className="grid grid-cols-7 gap-0 rounded-lg border overflow-hidden">
      {/* Header row */}
      {days.map((d, i) => (
        <div
          key={`h-${i}`}
          className={cn(
            "py-2 text-center text-xs font-medium border-b",
            d.toDateString() === today.toDateString()
              ? "text-primary"
              : "text-muted-foreground",
          )}
        >
          <div>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}</div>
          <div
            className={cn(
              "mx-auto mt-0.5 h-6 w-6 rounded-full flex items-center justify-center text-sm font-bold",
              d.toDateString() === today.toDateString()
                ? "bg-primary text-primary-foreground"
                : "",
            )}
          >
            {d.getDate()}
          </div>
        </div>
      ))}

      {/* Event cells */}
      {days.map((d, i) => {
        const dayStart = new Date(d);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(d);
        dayEnd.setHours(23, 59, 59, 999);
        const dayEvents = events.filter(
          (e) =>
            e.timestamp >= dayStart.getTime() &&
            e.timestamp <= dayEnd.getTime(),
        );
        const isSelected = selectedDay?.toDateString() === d.toDateString();
        const isLastCol = i === 6;

        return (
          <div
            key={`c-${i}`}
            onClick={() => onSelectDay(d)}
            className={cn(
              "min-h-[120px] p-1 space-y-0.5 cursor-pointer transition-colors",
              !isLastCol && "border-r",
              isSelected
                ? "bg-primary/5 ring-1 ring-inset ring-primary/30"
                : "hover:bg-accent/50",
            )}
          >
            {dayEvents.slice(0, 5).map((ev, j) => (
              <div
                key={j}
                className={cn(
                  "text-[10px] truncate rounded px-1 py-0.5",
                  ev.type === "published"
                    ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                    : ev.type === "scheduled"
                    ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                    : "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
                )}
              >
                {ev.title}
              </div>
            ))}
            {dayEvents.length > 5 && (
              <div className="text-[10px] text-muted-foreground pl-1">
                +{dayEvents.length - 5} more
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Day panel ───────────────────────────────────────────────────────────────

function DayPanel({
  selectedDay,
  events,
  onOpenDetail,
}: {
  selectedDay: Date | null;
  events: CalendarEvent[];
  onOpenDetail: (event: CalendarEvent) => void;
}) {
  if (!selectedDay) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
        <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-30" />
        Select a date to see events
      </div>
    );
  }

  const dateLabel = selectedDay.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b">
        <p className="font-semibold text-sm">{dateLabel}</p>
        <p className="text-xs text-muted-foreground">
          {events.length} event{events.length !== 1 ? "s" : ""}
        </p>
      </div>

      <div className="p-3 space-y-2 max-h-[60vh] overflow-y-auto">
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            Nothing scheduled
          </p>
        ) : (
          events.map((event, i) => (
            <div key={i} className="rounded-md border p-2.5 space-y-1">
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "h-2 w-2 rounded-full shrink-0",
                    event.type === "published"
                      ? "bg-green-500"
                      : event.type === "scheduled"
                      ? "bg-blue-500"
                      : "bg-orange-400",
                  )}
                />
                <span className="text-[10px] font-medium uppercase text-muted-foreground">
                  {event.type === "published"
                    ? "Published"
                    : event.type === "scheduled"
                    ? "Scheduled"
                    : "Auto-publish"}
                </span>
              </div>
              <p className="text-xs font-medium line-clamp-2">{event.title}</p>
              <p className="text-[10px] text-muted-foreground">
                {formatTimeEAT(event.timestamp)}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px] w-full"
                onClick={() => onOpenDetail(event)}
              >
                Full details
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ContentCalendarPage() {
  const allVideos = useQuery(api.videos.list);
  const settings = useQuery(api.settings.get);

  const today = new Date();

  const [view, setView] = useState<"month" | "week">("month");
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed
  const [weekOffset, setWeekOffset] = useState(0);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ── Week navigation ─────────────────────────────────────────────────────
  const weekStart = useMemo(() => {
    const t = new Date();
    const dayOfWeek = t.getDay(); // 0=Sun
    const monday = new Date(t);
    monday.setDate(t.getDate() - ((dayOfWeek + 6) % 7) + weekOffset * 7);
    monday.setHours(0, 0, 0, 0);
    return monday;
  }, [weekOffset]);

  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + 6);
    return d;
  }, [weekStart]);

  const weekLabel = `${weekStart.getDate()} ${weekStart.toLocaleString("default", { month: "short" })} – ${weekEnd.getDate()} ${weekEnd.toLocaleString("default", { month: "short" })} ${weekEnd.getFullYear()}`;

  // ── Navigation ──────────────────────────────────────────────────────────
  function goToPrev() {
    setSelectedDay(null);
    if (view === "week") {
      setWeekOffset((o) => o - 1);
    } else if (month === 0) {
      setMonth(11);
      setYear((y) => y - 1);
    } else {
      setMonth((m) => m - 1);
    }
  }

  function goToNext() {
    setSelectedDay(null);
    if (view === "week") {
      setWeekOffset((o) => o + 1);
    } else if (month === 11) {
      setMonth(0);
      setYear((y) => y + 1);
    } else {
      setMonth((m) => m + 1);
    }
  }

  function goToToday() {
    setSelectedDay(null);
    setWeekOffset(0);
    setYear(today.getFullYear());
    setMonth(today.getMonth());
  }

  function handleSelectDay(d: Date) {
    if (selectedDay?.toDateString() === d.toDateString()) {
      setSelectedDay(null); // deselect if same day clicked
    } else {
      setSelectedDay(d);
    }
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

  // ── Events for selected day ─────────────────────────────────────────────
  const eventsForSelectedDay = useMemo(() => {
    if (!selectedDay) return [];
    const start = new Date(selectedDay);
    start.setHours(0, 0, 0, 0);
    const end = new Date(selectedDay);
    end.setHours(23, 59, 59, 999);
    return allEvents
      .filter(
        (e) => e.timestamp >= start.getTime() && e.timestamp <= end.getTime(),
      )
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [selectedDay, allEvents]);

  // ── Detail video lookup ─────────────────────────────────────────────────
  const detailVideo = useMemo(
    () =>
      (allVideos ?? []).find((v) => v._id === detailEvent?.videoId) ?? null,
    [allVideos, detailEvent],
  );

  // ── Summary stats ────────────────────────────────────────────────────────
  const monthStart = new Date(year, month, 1).getTime();
  const monthEnd = new Date(year, month + 1, 1).getTime();

  const publishedThisMonth = allEvents.filter(
    (e) =>
      e.type === "published" &&
      e.timestamp >= monthStart &&
      e.timestamp < monthEnd,
  ).length;

  const totalScheduled = allEvents.filter((e) => e.type === "scheduled").length;
  const totalAutoQueued = (allVideos ?? []).filter(
    (v) => v.status === "ready",
  ).length;

  // ── Loading ──────────────────────────────────────────────────────────────
  if (allVideos === undefined || settings === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5" />
          <h1 className="text-2xl font-bold">Content Calendar</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* View switcher */}
          <div className="flex rounded-md border overflow-hidden">
            <button
              onClick={() => setView("month")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium transition-colors",
                view === "month"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent text-muted-foreground",
              )}
            >
              Month
            </button>
            <button
              onClick={() => setView("week")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium transition-colors border-l",
                view === "week"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent text-muted-foreground",
              )}
            >
              Week
            </button>
          </div>

          <Button variant="outline" size="sm" onClick={goToToday}>
            Today
          </Button>
          <Button variant="ghost" size="icon" onClick={goToPrev}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Previous</span>
          </Button>
          <Button variant="ghost" size="icon" onClick={goToNext}>
            <ChevronRight className="h-4 w-4" />
            <span className="sr-only">Next</span>
          </Button>
          <span className="text-lg font-semibold w-48 text-center">
            {view === "month"
              ? `${MONTH_NAMES[month]} ${year}`
              : weekLabel}
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

      {/* Two-column layout */}
      <div className="flex gap-4 items-start">
        {/* Calendar — takes most of the space */}
        <div className="flex-1 min-w-0">
          {view === "month" ? (
            <MonthGrid
              grid={grid}
              selectedDay={selectedDay}
              onSelectDay={handleSelectDay}
            />
          ) : (
            <WeekGrid
              weekStart={weekStart}
              events={allEvents}
              selectedDay={selectedDay}
              onSelectDay={handleSelectDay}
            />
          )}
        </div>

        {/* Side panel — desktop only, fixed width */}
        <div className="hidden lg:block w-72 shrink-0 sticky top-4">
          <DayPanel
            selectedDay={selectedDay}
            events={eventsForSelectedDay}
            onOpenDetail={(ev) => setDetailEvent(ev)}
          />
        </div>
      </div>

      {/* Mobile: Sheet slides in from right when a day is selected */}
      <Sheet
        open={!!selectedDay && isMobile}
        onOpenChange={(open) => {
          if (!open) setSelectedDay(null);
        }}
      >
        <SheetContent side="right" className="w-80">
          <SheetTitle className="sr-only">Selected day</SheetTitle>
          <SheetDescription className="sr-only">
            Events for the selected date
          </SheetDescription>
          <DayPanel
            selectedDay={selectedDay}
            events={eventsForSelectedDay}
            onOpenDetail={(ev) => setDetailEvent(ev)}
          />
        </SheetContent>
      </Sheet>

      {/* Full details modal */}
      <Dialog
        open={!!detailEvent}
        onOpenChange={(open) => {
          if (!open) setDetailEvent(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {detailVideo?.aiTitle ?? detailVideo?.title ?? "Video"}
            </DialogTitle>
            <DialogDescription>
              {detailEvent?.type === "published"
                ? "Published"
                : detailEvent?.type === "scheduled"
                ? "Manually scheduled"
                : "Auto-publish estimate"}
              {" · "}
              {detailEvent ? formatDateTimeEAT(detailEvent.timestamp) : ""}
            </DialogDescription>
          </DialogHeader>

          {detailVideo && (
            <div className="space-y-3">
              {detailVideo.thumbnailUrl && (
                <img
                  src={detailVideo.thumbnailUrl}
                  alt=""
                  className="w-full rounded-md aspect-video object-cover"
                />
              )}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Status</span>
                  <p className="font-medium capitalize">{detailVideo.status}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Privacy</span>
                  <p className="font-medium capitalize">
                    {detailVideo.privacyStatus ?? "—"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Type</span>
                  <p className="font-medium capitalize">
                    {detailVideo.publishAs ?? "video"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Size</span>
                  <p className="font-medium">
                    {formatBytes(detailVideo.rawFileSize)}
                  </p>
                </div>
              </div>
              {detailVideo.aiDescription && (
                <p className="text-xs text-muted-foreground line-clamp-3">
                  {detailVideo.aiDescription}
                </p>
              )}
              {detailVideo.publishedVideoId && (
                <a
                  href={`https://youtu.be/${detailVideo.publishedVideoId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" /> View on YouTube
                </a>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

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
