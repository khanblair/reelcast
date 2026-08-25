"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { formatTimeEAT, formatDateTimeEAT, nextAutoPublishSlot } from "@/lib/eat";
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

type View = "year" | "month" | "week" | "day";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CalendarEvent {
  videoId: string;
  title: string;
  type: "published" | "scheduled" | "auto";
  timestamp: number;
}

interface CalendarSlot {
  date: Date;
  dayNum: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  events: CalendarEvent[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeAutoEvents(videos: any[], settings: any | null): CalendarEvent[] {
  if (!settings?.autoPublishEnabled || !settings.autoPublishNextAt) return [];
  const nextAt: number = settings.autoPublishNextAt;
  const intervalMs: number = settings.autoPublishIntervalMs ?? 6 * 3_600_000;
  const count: number = settings.autoPublishCount ?? 1;
  const timeSlots: number[] | undefined = settings.autoPublishTimeSlots;
  const tzOffset: number = settings.autoPublishTimezoneOffset ?? 3;
  const readyVideos = [...videos]
    .filter((v) => v.status === "ready" && !v.storageMissing)
    .sort(
      (a, b) =>
        (a.publishOrder ?? 9999) - (b.publishOrder ?? 9999) ||
        a._creationTime - b._creationTime,
    );

  // When specific time-of-day slots are configured, project each future run's
  // wall-clock time the same way the backend scheduler does — otherwise every
  // event collapses to the stale default 6h-interval pattern regardless of
  // what was actually set on the Schedule page.
  if (timeSlots?.length) {
    const totalRuns = Math.ceil(readyVideos.length / count);
    const slotTimes: number[] = [nextAt];
    for (let r = 1; r < totalRuns; r++) {
      slotTimes.push(nextAutoPublishSlot(timeSlots, slotTimes[r - 1], tzOffset));
    }
    return readyVideos.map((v, i) => ({
      videoId: v._id,
      title: v.aiTitle ?? v.title ?? "Untitled",
      type: "auto" as const,
      timestamp: slotTimes[Math.floor(i / count)],
    }));
  }

  return readyVideos.map((v, i) => ({
    videoId: v._id,
    title: v.aiTitle ?? v.title ?? "Untitled",
    type: "auto" as const,
    timestamp: nextAt + Math.floor(i / count) * intervalMs,
  }));
}

function buildGrid(year: number, month: number, events: CalendarEvent[]): CalendarSlot[] {
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const todayTs = todayMidnight.getTime();
  const firstOfMonth = new Date(year, month, 1);
  const startDow = (firstOfMonth.getDay() + 6) % 7;
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

function eventColors(type: CalendarEvent["type"]) {
  if (type === "published")
    return "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300";
  if (type === "scheduled")
    return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
  return "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300";
}

function eventDot(type: CalendarEvent["type"]) {
  if (type === "published") return "bg-green-500";
  if (type === "scheduled") return "bg-blue-500";
  return "bg-orange-400";
}

// ─── Event pill (month + week views) ─────────────────────────────────────────

function EventPill({
  event,
  onClick,
}: {
  event: CalendarEvent;
  onClick: (e: CalendarEvent) => void;
}) {
  return (
    <div
      onClick={(ev) => {
        ev.stopPropagation();
        onClick(event);
      }}
      className={cn(
        "text-[10px] truncate rounded px-1 py-0.5 cursor-pointer leading-snug transition-opacity hover:opacity-75",
        eventColors(event.type),
      )}
    >
      {event.type === "published"
        ? event.title
        : event.type === "scheduled"
        ? `${formatTimeEAT(event.timestamp)} · ${event.title}`
        : `Auto · ${formatTimeEAT(event.timestamp)}`}
    </div>
  );
}

// ─── Month grid ──────────────────────────────────────────────────────────────

function MonthGrid({
  grid,
  selectedDay,
  onSelectDay,
  onOpenDetail,
}: {
  grid: CalendarSlot[];
  selectedDay: Date | null;
  onSelectDay: (d: Date) => void;
  onOpenDetail: (e: CalendarEvent) => void;
}) {
  const MAX_VISIBLE = 3;
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <div className="min-w-[560px]">
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
          <div className="grid grid-cols-7">
            {grid.map((slot, idx) => {
              const isLastRow = idx >= 35;
              const isLastCol = (idx + 1) % 7 === 0;
              const overflow = slot.events.length - MAX_VISIBLE;
              const isSelected = selectedDay?.toDateString() === slot.date.toDateString();
              return (
                <div
                  key={slot.date.toISOString()}
                  onClick={() => {
                    if (slot.isCurrentMonth) onSelectDay(slot.date);
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
                  {slot.isCurrentMonth && (
                    <div className="flex flex-col gap-0.5">
                      {slot.events.slice(0, MAX_VISIBLE).map((e, i) => (
                        <EventPill key={`${e.videoId}-${i}`} event={e} onClick={onOpenDetail} />
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
  onOpenDetail,
}: {
  weekStart: Date;
  events: CalendarEvent[];
  selectedDay: Date | null;
  onSelectDay: (d: Date) => void;
  onOpenDetail: (e: CalendarEvent) => void;
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
      {days.map((d, i) => (
        <div
          key={`h-${i}`}
          className={cn(
            "py-2 text-center text-xs font-medium border-b",
            d.toDateString() === today.toDateString() ? "text-primary" : "text-muted-foreground",
          )}
        >
          <div>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]}</div>
          <div
            className={cn(
              "mx-auto mt-0.5 h-6 w-6 rounded-full flex items-center justify-center text-sm font-bold",
              d.toDateString() === today.toDateString() ? "bg-primary text-primary-foreground" : "",
            )}
          >
            {d.getDate()}
          </div>
        </div>
      ))}
      {days.map((d, i) => {
        const dayStart = new Date(d);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(d);
        dayEnd.setHours(23, 59, 59, 999);
        const dayEvents = events.filter(
          (e) => e.timestamp >= dayStart.getTime() && e.timestamp <= dayEnd.getTime(),
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
              <EventPill key={j} event={ev} onClick={onOpenDetail} />
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

// ─── Day timeline (hourly, Google Calendar style) ─────────────────────────────

const HOUR_H = 56; // px per hour row

function DayTimeline({
  dayDate,
  events,
  onOpenDetail,
}: {
  dayDate: Date;
  events: CalendarEvent[];
  onOpenDetail: (e: CalendarEvent) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const HOURS = Array.from({ length: 24 }, (_, i) => i);
  const now = new Date();
  const isToday = dayDate.toDateString() === now.toDateString();

  useEffect(() => {
    const targetHour =
      events.length > 0
        ? Math.max(0, new Date(events[0].timestamp).getHours() - 1)
        : 6;
    scrollRef.current?.scrollTo({ top: targetHour * HOUR_H, behavior: "smooth" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayDate.toDateString()]);

  const currentTimeTop = isToday
    ? (now.getHours() + now.getMinutes() / 60) * HOUR_H
    : -1;

  return (
    <Card>
      <CardContent className="p-0">
        <div ref={scrollRef} className="overflow-y-auto max-h-[600px] relative">
          {isToday && currentTimeTop >= 0 && (
            <div
              className="absolute left-16 right-0 z-10 pointer-events-none"
              style={{ top: currentTimeTop }}
            >
              <div className="relative">
                <div className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full bg-red-500" />
                <div className="border-t border-red-500 w-full" />
              </div>
            </div>
          )}

          {HOURS.map((hour) => {
            const hourEvents = events.filter(
              (e) => new Date(e.timestamp).getHours() === hour,
            );
            const isCurrentHour = isToday && now.getHours() === hour;
            return (
              <div
                key={hour}
                className={cn(
                  "flex border-b",
                  isCurrentHour && "bg-primary/5",
                )}
                style={{ minHeight: HOUR_H }}
              >
                <div className="w-16 shrink-0 px-2 pt-1 text-xs text-muted-foreground text-right border-r select-none">
                  {hour.toString().padStart(2, "0")}:00
                </div>
                <div className="flex-1 p-1 flex flex-col gap-1">
                  {hourEvents.map((ev, i) => (
                    <div
                      key={i}
                      onClick={() => onOpenDetail(ev)}
                      className={cn(
                        "rounded-sm px-2 py-1.5 cursor-pointer text-xs hover:opacity-80 transition-opacity border-l-[3px]",
                        ev.type === "published"
                          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-green-500"
                          : ev.type === "scheduled"
                          ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-blue-500"
                          : "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300 border-orange-400",
                      )}
                    >
                      <span className="font-semibold mr-2">
                        {formatTimeEAT(ev.timestamp)}
                      </span>
                      <span className="truncate">{ev.title}</span>
                      <span className="ml-2 opacity-60 text-[10px] capitalize">
                        {ev.type === "auto" ? "auto-publish" : ev.type}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Year view ────────────────────────────────────────────────────────────────

function YearView({
  year,
  events,
  onSelectMonth,
}: {
  year: number;
  events: CalendarEvent[];
  onSelectMonth: (month: number) => void;
}) {
  const today = new Date();
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {Array.from({ length: 12 }, (_, m) => {
        const monthStart = new Date(year, m, 1).getTime();
        const monthEnd = new Date(year, m + 1, 1).getTime();
        const monthEvents = events.filter(
          (e) => e.timestamp >= monthStart && e.timestamp < monthEnd,
        );
        const daysInMonth = new Date(year, m + 1, 0).getDate();
        const firstDow = (new Date(year, m, 1).getDay() + 6) % 7;
        const isCurrentMonth =
          today.getFullYear() === year && today.getMonth() === m;

        return (
          <div
            key={m}
            onClick={() => onSelectMonth(m)}
            className={cn(
              "rounded-lg border p-3 cursor-pointer hover:bg-accent/30 transition-colors",
              isCurrentMonth && "ring-1 ring-primary",
            )}
          >
            <p
              className={cn(
                "text-xs font-semibold mb-2",
                isCurrentMonth && "text-primary",
              )}
            >
              {MONTH_NAMES[m]}
            </p>

            {/* Mini grid */}
            <div className="grid grid-cols-7 gap-px">
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <div
                  key={i}
                  className="text-[7px] text-center text-muted-foreground leading-3"
                >
                  {d}
                </div>
              ))}
              {Array.from({ length: firstDow }, (_, i) => (
                <div key={`p${i}`} />
              ))}
              {Array.from({ length: daysInMonth }, (_, i) => {
                const dayNum = i + 1;
                const dayStart = new Date(year, m, dayNum).setHours(0, 0, 0, 0);
                const dayEnd = dayStart + 86_400_000;
                const dayEvs = monthEvents.filter(
                  (e) => e.timestamp >= dayStart && e.timestamp < dayEnd,
                );
                const isToday =
                  new Date(year, m, dayNum).toDateString() === today.toDateString();
                const hasPublished = dayEvs.some((e) => e.type === "published");
                const hasScheduled = dayEvs.some((e) => e.type === "scheduled");
                const hasAuto = dayEvs.some((e) => e.type === "auto");
                return (
                  <div key={dayNum} className="flex flex-col items-center">
                    <span
                      className={cn(
                        "text-[7px] leading-3 w-4 h-4 flex items-center justify-center rounded-full",
                        isToday
                          ? "bg-primary text-primary-foreground font-bold"
                          : "text-foreground",
                      )}
                    >
                      {dayNum}
                    </span>
                    {dayEvs.length > 0 && (
                      <div className="flex gap-px mt-px">
                        {hasPublished && (
                          <div className="h-1 w-1 rounded-full bg-green-500" />
                        )}
                        {hasScheduled && (
                          <div className="h-1 w-1 rounded-full bg-blue-500" />
                        )}
                        {hasAuto && (
                          <div className="h-1 w-1 rounded-full bg-orange-400" />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-[10px] text-muted-foreground mt-2">
              {monthEvents.length} event{monthEvents.length !== 1 ? "s" : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// ─── Day panel (side panel for month + week views) ───────────────────────────

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
            <div
              key={i}
              onClick={() => onOpenDetail(event)}
              className="rounded-md border p-2.5 space-y-1 cursor-pointer hover:bg-accent/30 transition-colors"
            >
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "h-2 w-2 rounded-full shrink-0",
                    eventDot(event.type),
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
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Detail modal ─────────────────────────────────────────────────────────────

function DetailModal({
  detailEvent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detailVideo,
  onClose,
}: {
  detailEvent: CalendarEvent | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  detailVideo: any | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!detailEvent} onOpenChange={(open) => { if (!open) onClose(); }}>
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
                <span className="text-xs text-muted-foreground">Status</span>
                <p className="font-medium capitalize">{detailVideo.status}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Privacy</span>
                <p className="font-medium capitalize">
                  {detailVideo.privacyStatus ?? "—"}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Type</span>
                <p className="font-medium capitalize">
                  {detailVideo.publishAs ?? "video"}
                </p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">Size</span>
                <p className="font-medium">{formatBytes(detailVideo.rawFileSize)}</p>
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
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ContentCalendarPage() {
  const allVideos = useQuery(api.videos.list);
  const settings = useQuery(api.settings.get);

  const todayMidnight = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [view, setView] = useState<View>("month");
  const [year, setYear] = useState(todayMidnight.getFullYear());
  const [month, setMonth] = useState(todayMidnight.getMonth());
  const [weekOffset, setWeekOffset] = useState(0);
  const [dayDate, setDayDate] = useState<Date>(todayMidnight);
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // ── Week bounds ─────────────────────────────────────────────────────────
  const weekStart = useMemo(() => {
    const t = new Date();
    const dow = t.getDay();
    const mon = new Date(t);
    mon.setDate(t.getDate() - ((dow + 6) % 7) + weekOffset * 7);
    mon.setHours(0, 0, 0, 0);
    return mon;
  }, [weekOffset]);

  const weekEnd = useMemo(() => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + 6);
    return d;
  }, [weekStart]);

  // ── Navigation ──────────────────────────────────────────────────────────
  function goToPrev() {
    setSelectedDay(null);
    if (view === "year") {
      setYear((y) => y - 1);
    } else if (view === "week") {
      setWeekOffset((o) => o - 1);
    } else if (view === "day") {
      setDayDate((d) => {
        const p = new Date(d);
        p.setDate(d.getDate() - 1);
        return p;
      });
    } else {
      if (month === 0) {
        setMonth(11);
        setYear((y) => y - 1);
      } else {
        setMonth((m) => m - 1);
      }
    }
  }

  function goToNext() {
    setSelectedDay(null);
    if (view === "year") {
      setYear((y) => y + 1);
    } else if (view === "week") {
      setWeekOffset((o) => o + 1);
    } else if (view === "day") {
      setDayDate((d) => {
        const n = new Date(d);
        n.setDate(d.getDate() + 1);
        return n;
      });
    } else {
      if (month === 11) {
        setMonth(0);
        setYear((y) => y + 1);
      } else {
        setMonth((m) => m + 1);
      }
    }
  }

  // Today → always switch to Day view showing today
  function goToToday() {
    setSelectedDay(null);
    setWeekOffset(0);
    setYear(todayMidnight.getFullYear());
    setMonth(todayMidnight.getMonth());
    setDayDate(new Date(todayMidnight));
    setView("day");
  }

  function handleSelectDay(d: Date) {
    if (selectedDay?.toDateString() === d.toDateString()) {
      setSelectedDay(null);
    } else {
      setSelectedDay(d);
    }
  }

  // ── All events ──────────────────────────────────────────────────────────
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

  const eventsForSelectedDay = useMemo(() => {
    if (!selectedDay) return [];
    const start = new Date(selectedDay);
    start.setHours(0, 0, 0, 0);
    const end = new Date(selectedDay);
    end.setHours(23, 59, 59, 999);
    return allEvents
      .filter((e) => e.timestamp >= start.getTime() && e.timestamp <= end.getTime())
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [selectedDay, allEvents]);

  const eventsForDayView = useMemo(() => {
    const start = new Date(dayDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(dayDate);
    end.setHours(23, 59, 59, 999);
    return allEvents
      .filter((e) => e.timestamp >= start.getTime() && e.timestamp <= end.getTime())
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [dayDate, allEvents]);

  const detailVideo = useMemo(
    () => (allVideos ?? []).find((v) => v._id === detailEvent?.videoId) ?? null,
    [allVideos, detailEvent],
  );

  // ── Dynamic stat cards ──────────────────────────────────────────────────
  const { statsLabel, statPublished, statScheduled, statAutoQueued } = useMemo(() => {
    let rangeStart = 0;
    let rangeEnd = Infinity;
    let label = "";

    if (view === "day") {
      const s = new Date(dayDate);
      s.setHours(0, 0, 0, 0);
      const e = new Date(dayDate);
      e.setHours(23, 59, 59, 999);
      rangeStart = s.getTime();
      rangeEnd = e.getTime();
      label = "Today";
    } else if (view === "week") {
      rangeStart = weekStart.getTime();
      rangeEnd = weekEnd.getTime() + 86_400_000;
      label = "This Week";
    } else if (view === "month") {
      rangeStart = new Date(year, month, 1).getTime();
      rangeEnd = new Date(year, month + 1, 1).getTime();
      label = "This Month";
    } else {
      rangeStart = new Date(year, 0, 1).getTime();
      rangeEnd = new Date(year + 1, 0, 1).getTime();
      label = `${year}`;
    }

    const inRange = (e: CalendarEvent) =>
      e.timestamp >= rangeStart && e.timestamp < rangeEnd;

    const published = allEvents.filter(
      (e) => e.type === "published" && inRange(e),
    ).length;
    const sched = allEvents.filter(
      (e) => e.type === "scheduled" && inRange(e),
    ).length;

    // For day/week: count auto events in range; for month/year: total ready queue
    const auto =
      view === "day" || view === "week"
        ? allEvents.filter((e) => e.type === "auto" && inRange(e)).length
        : (allVideos ?? []).filter((v) => v.status === "ready").length;

    return {
      statsLabel: label,
      statPublished: published,
      statScheduled: sched,
      statAutoQueued: auto,
    };
  }, [view, dayDate, weekStart, weekEnd, year, month, allEvents, allVideos]);

  // ── Nav label ───────────────────────────────────────────────────────────
  const navLabel = useMemo(() => {
    if (view === "year") return `${year}`;
    if (view === "month") return `${MONTH_NAMES[month]} ${year}`;
    if (view === "week") {
      const ws = weekStart;
      const we = weekEnd;
      return `${ws.getDate()} ${ws.toLocaleString("default", { month: "short" })} – ${we.getDate()} ${we.toLocaleString("default", { month: "short" })} ${we.getFullYear()}`;
    }
    return dayDate.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }, [view, year, month, weekStart, weekEnd, dayDate]);

  if (allVideos === undefined || settings === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const showSidePanel = view === "month" || view === "week";

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
            {(["year", "month", "week", "day"] as View[]).map((v, i) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                  i > 0 && "border-l",
                  view === v
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-accent text-muted-foreground",
                )}
              >
                {v}
              </button>
            ))}
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
          <span className="text-sm font-semibold min-w-[200px] text-center">
            {navLabel}
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

      {/* Stat cards, above calendar, dynamic by view */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">
              Published · {statsLabel}
            </p>
            <p className="text-2xl font-bold mt-1">{statPublished}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">
              Scheduled · {statsLabel}
            </p>
            <p className="text-2xl font-bold mt-1">{statScheduled}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Auto-queued</p>
            <p className="text-2xl font-bold mt-1">{statAutoQueued}</p>
          </CardContent>
        </Card>
      </div>

      {/* Calendar area */}
      {view === "year" && (
        <YearView
          year={year}
          events={allEvents}
          onSelectMonth={(m) => {
            setMonth(m);
            setView("month");
          }}
        />
      )}

      {view === "day" && (
        <DayTimeline
          dayDate={dayDate}
          events={eventsForDayView}
          onOpenDetail={setDetailEvent}
        />
      )}

      {showSidePanel && (
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0">
            {view === "month" ? (
              <MonthGrid
                grid={grid}
                selectedDay={selectedDay}
                onSelectDay={handleSelectDay}
                onOpenDetail={setDetailEvent}
              />
            ) : (
              <WeekGrid
                weekStart={weekStart}
                events={allEvents}
                selectedDay={selectedDay}
                onSelectDay={handleSelectDay}
                onOpenDetail={setDetailEvent}
              />
            )}
          </div>

          <div className="hidden lg:block w-72 shrink-0 sticky top-4">
            <DayPanel
              selectedDay={selectedDay}
              events={eventsForSelectedDay}
              onOpenDetail={setDetailEvent}
            />
          </div>
        </div>
      )}

      {/* Mobile sheet for month/week side panel */}
      {showSidePanel && (
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
              onOpenDetail={setDetailEvent}
            />
          </SheetContent>
        </Sheet>
      )}

      {/* Detail modal, shared across all views */}
      <DetailModal
        detailEvent={detailEvent}
        detailVideo={detailVideo}
        onClose={() => setDetailEvent(null)}
      />
    </div>
  );
}
