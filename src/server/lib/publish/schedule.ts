/**
 * Auto-publish scheduling math. Pure (no DB, no clock): shared by the `autoPublish.run` task handler
 * and by whoever starts auto-publish (agent B's settings module), so both compute the same instant.
 */
const HOUR_MS = 3_600_000;

/** The fields of a `settings` row this module reads. A full settings row satisfies it. */
export type AutoPublishScheduleSettings = {
  /** Fixed gap between runs when no time slots are configured. Default 6 hours. */
  autoPublishIntervalMs?: number | null;
  /** Local hours of the day (0-23) to run at. When non-empty it wins over the interval. */
  autoPublishTimeSlots?: readonly number[] | null;
  /** Offset of the user's timezone from UTC in HOURS (may be fractional, e.g. 5.5). Default +3 (EAT). */
  autoPublishTimezoneOffset?: number | null;
};

export const DEFAULT_AUTO_PUBLISH_INTERVAL_MS = 6 * HOUR_MS;
export const DEFAULT_TIMEZONE_OFFSET_HOURS = 3;
/** A slot closer than this to `from` is skipped, so a run never schedules itself "right now". */
export const MIN_LEAD_MS = 60_000;

/**
 * The next time (epoch ms) a time-slot schedule should fire after `nowMs`: the first slot of the
 * user's local day that is at least 60s ahead, else the first slot of the next local day.
 * `timeSlots` are local hours; `timezoneOffsetHours` is the user's UTC offset in hours.
 */
export function nextSlotMs(timeSlots: readonly number[], nowMs: number, timezoneOffsetHours = DEFAULT_TIMEZONE_OFFSET_HOURS): number {
  const slots = timeSlots.filter((h) => Number.isFinite(h)).sort((a, b) => a - b);
  const offsetMs = timezoneOffsetHours * HOUR_MS;
  const local = new Date(nowMs + offsetMs);
  const msSinceLocalMidnight =
    local.getUTCHours() * HOUR_MS + local.getUTCMinutes() * 60_000 + local.getUTCSeconds() * 1_000 + local.getUTCMilliseconds();
  const localMidnightMs = nowMs - msSinceLocalMidnight;
  const minFutureMs = nowMs + MIN_LEAD_MS;
  for (const h of slots) {
    const slotMs = localMidnightMs + h * HOUR_MS;
    if (slotMs >= minFutureMs) return slotMs;
  }
  return localMidnightMs + 24 * HOUR_MS + slots[0] * HOUR_MS;
}

/**
 * When the next auto-publish run should happen, given the user's settings and the moment a run
 * (or start) happens (`from`). Time slots (if any) take precedence over the interval.
 */
export function computeNextAutoPublishAt(settings: AutoPublishScheduleSettings, from: Date): Date {
  const slots = (settings.autoPublishTimeSlots ?? []).filter((h) => Number.isFinite(h));
  if (slots.length > 0) {
    return new Date(nextSlotMs(slots, from.getTime(), settings.autoPublishTimezoneOffset ?? DEFAULT_TIMEZONE_OFFSET_HOURS));
  }
  const interval = settings.autoPublishIntervalMs && settings.autoPublishIntervalMs > 0 ? settings.autoPublishIntervalMs : DEFAULT_AUTO_PUBLISH_INTERVAL_MS;
  return new Date(from.getTime() + interval);
}
