import { cn } from "@/lib/utils";
import { UNLIMITED_THRESHOLD, USAGE_LABELS } from "./plans";

export function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = limit >= UNLIMITED_THRESHOLD;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const atLimit = !unlimited && used >= limit;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("font-medium tabular-nums", atLimit && "text-destructive")}>
          {used} {unlimited ? "" : `/ ${limit}`}
          {unlimited && <span className="text-muted-foreground font-normal"> (unlimited)</span>}
        </span>
      </div>
      {!unlimited && (
        <div
          className="h-1.5 w-full rounded-full bg-secondary overflow-hidden"
          role="progressbar"
          aria-label={label}
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={limit}
        >
          <div className={cn("h-full rounded-full transition-all", atLimit ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export function UsageMeters({ items }: { items: Record<string, { used: number; limit: number } | undefined> }) {
  return (
    <>
      {Object.keys(USAGE_LABELS).map((field) => {
        const stat = items[field];
        if (!stat) return null;
        return <UsageBar key={field} label={USAGE_LABELS[field]} used={stat.used} limit={stat.limit} />;
      })}
    </>
  );
}
