import type { Tone } from "@/components/admin/billing/format";
import { StatusDot } from "@/components/admin/billing/status-dot";
import { SkeletonBar } from "@/components/admin/shell/admin-skeleton";

/** A labelled value with a status dot. The label carries the meaning; the dot only supports it. `undefined` = still loading. */
export function StatBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string | undefined;
  tone: Tone;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-sm text-muted-foreground">
        <StatusDot tone={tone} label={label} />
      </p>
      {value === undefined ? (
        <SkeletonBar className="mt-2 h-7 w-10" />
      ) : (
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      )}
    </div>
  );
}
