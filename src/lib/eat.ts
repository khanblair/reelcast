// East Africa Time utilities, Uganda/Kampala is UTC+3 (Africa/Nairobi)
const TZ = "Africa/Nairobi";

export function formatDateTimeEAT(ms: number): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(ms) + " EAT"
  );
}

export function formatTimeEAT(ms: number): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(ms) + " EAT"
  );
}

export function formatFullDateEAT(ms: number): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(ms) + " EAT"
  );
}

export function formatCountdown(remainingMs: number): string {
  const s = Math.max(0, Math.floor(remainingMs / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

// Next wall-clock auto-publish slot strictly after `afterMs`, given hour-of-day
// slots (0-23) in a fixed timezone offset. Single source of truth for all
// frontend auto-publish time projections — mirrors nextSlotMs in
// convex/actions/autoPublish.ts, the backend scheduler's authoritative version.
export function nextAutoPublishSlot(slots: number[], afterMs: number, tzOffsetHours = 3): number {
  const TZ_MS = tzOffsetHours * 3_600_000;
  const shifted = new Date(afterMs + TZ_MS);
  const msSinceMidnight =
    shifted.getUTCHours() * 3_600_000 +
    shifted.getUTCMinutes() * 60_000 +
    shifted.getUTCSeconds() * 1_000 +
    shifted.getUTCMilliseconds();
  const midnight = afterMs - msSinceMidnight;
  const sorted = [...slots].sort((a, b) => a - b);
  for (const h of sorted) {
    const slotMs = midnight + h * 3_600_000;
    if (slotMs > afterMs) return slotMs;
  }
  return midnight + 24 * 3_600_000 + sorted[0] * 3_600_000;
}
