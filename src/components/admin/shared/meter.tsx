import type { Tone } from "@/components/admin/billing/format";
import { cn } from "@/lib/utils";

const FILL: Record<Tone, string> = {
  success: "bg-success",
  pending: "bg-warning",
  danger: "bg-destructive",
  neutral: "bg-foreground/50",
};

/** Tone for a quota-style meter: neutral while healthy, amber from 50%, red from 80%. */
export const quotaTone = (pct: number): Tone =>
  pct >= 80 ? "danger" : pct >= 50 ? "pending" : "neutral";

/** Thin horizontal meter. `value` is a percentage from 0 to 100; the label names it for assistive tech. */
export function Meter({
  value,
  label,
  tone = "neutral",
  className,
}: {
  value: number;
  label: string;
  tone?: Tone;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-150 motion-reduce:transition-none",
          FILL[tone]
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
