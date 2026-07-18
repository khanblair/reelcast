// East Africa Time utilities — Uganda/Kampala is UTC+3 (Africa/Nairobi)
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
