"use client";

import { formatDistanceStrict } from "date-fns";
import { Check, CircleHelp, TriangleAlert } from "lucide-react";
import { api, useQuery } from "@/lib/rpc/client";
import type { ReturnOf } from "@/lib/rpc/types";
import { TableSkeleton } from "@/components/admin/shell/admin-skeleton";
import { Td, Th } from "@/components/admin/billing/table-parts";
import { SectionCard } from "@/components/admin/shared/section-card";
import { StatBlock } from "@/components/admin/shared/stat-block";
import { Table, TableBody, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTimeEAT } from "@/lib/eat";

type Health = ReturnOf<typeof api.admin.queue.getHealth>;

/** "45 seconds", "7 minutes". */
const age = (ms: number) => formatDistanceStrict(0, ms);

/**
 * Is the job runner alive? Three states, always with words (the icon only supports them):
 *  - stale: the production tick last finished more than 3 minutes ago. Nothing is being processed.
 *  - none: no heartbeat has ever been recorded. Normal on a local or preview database: only the production cron route writes it.
 *  - running: the tick finished recently.
 */
function TickBanner({ tick }: { tick: Health["tick"] }) {
  const base = "flex items-start gap-2 rounded-lg border p-3 text-sm";
  if (tick.stale) {
    return (
      <p role="alert" className={`${base} border-destructive/40 bg-destructive/5`}>
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>
          <strong className="font-medium">Tick stale.</strong> The job runner last finished {age(tick.ageMs ?? 0)} ago (it should run every minute), so
          jobs and tasks are not being processed. Check the pg_cron job and the /api/cron/tick route.
        </span>
      </p>
    );
  }
  if (tick.lastRunAt === undefined) {
    return (
      <p role="status" className={`${base} border-border`}>
        <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span>
          <strong className="font-medium">No tick recorded.</strong> The production scheduler writes a heartbeat every minute; a local or preview database
          never has one.
        </span>
      </p>
    );
  }
  return (
    <p role="status" className={`${base} border-border`}>
      <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
      <span>
        <strong className="font-medium">Tick running.</strong> Last finished {age(tick.ageMs ?? 0)} ago.
        {tick.lastError ? <span className="text-muted-foreground"> That tick reported errors: {tick.lastError}</span> : null}
      </span>
    </p>
  );
}

export function QueueHealthSection() {
  const health = useQuery(api.admin.queue.getHealth);
  const q = health?.queue;

  return (
    <SectionCard
      title="Job runner"
      description="Background jobs and tasks, the scheduled sweeps and the tick that drives them. Refreshes every 10 seconds while work is waiting, otherwise every minute."
    >
      <div className="space-y-4 p-4">
        {health ? <TickBanner tick={health.tick} /> : null}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatBlock label="Jobs waiting" value={q?.jobs.pending} tone={q && q.jobs.pending > 0 ? "pending" : "neutral"} />
          <StatBlock label="Jobs running" value={q?.jobs.processing} tone={q && q.jobs.processing > 0 ? "pending" : "neutral"} />
          <StatBlock label="Tasks waiting" value={q?.tasks.pending} tone={q && q.tasks.pending > 0 ? "pending" : "neutral"} />
          <StatBlock label="Tasks running" value={q?.tasks.processing} tone={q && q.tasks.processing > 0 ? "pending" : "neutral"} />
          <StatBlock
            label="Oldest waiting"
            value={q === undefined ? undefined : q.oldestPendingAgeMs === undefined ? "None" : age(q.oldestPendingAgeMs)}
            tone={q?.oldestPendingAgeMs === undefined ? "neutral" : "pending"}
          />
          <StatBlock label="Scheduled for later" value={q && q.jobs.scheduled + q.tasks.scheduled} tone="neutral" />
          <StatBlock label="Failed jobs, 24 h" value={q?.jobs.failedLast24h} tone={q && q.jobs.failedLast24h > 0 ? "danger" : "success"} />
          <StatBlock label="Failed tasks, 24 h" value={q?.tasks.failedLast24h} tone={q && q.tasks.failedLast24h > 0 ? "danger" : "success"} />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Failed tasks</h3>
          {health === undefined ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <TableSkeleton rows={3} cols={4} />
            </div>
          ) : health.failedTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No failed tasks.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table className="min-w-[640px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Task</Th>
                    <Th>Attempts</Th>
                    <Th>Last error</Th>
                    <Th>Failed</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.failedTasks.map((t) => (
                    <TableRow key={t._id}>
                      <Td className="whitespace-nowrap">{t.kind}</Td>
                      <Td className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {t.attempts}/{t.maxAttempts}
                      </Td>
                      <Td className="max-w-[420px] truncate text-muted-foreground" title={t.lastError}>
                        {t.lastError ?? "—"}
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDateTimeEAT(t.failedAt)}</Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Sweeps whose last run failed</h3>
          {health === undefined ? (
            <div className="overflow-hidden rounded-lg border border-border">
              <TableSkeleton rows={2} cols={3} />
            </div>
          ) : health.scheduleErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sweep is failing.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <Th>Sweep</Th>
                    <Th>Last run</Th>
                    <Th>Error</Th>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {health.scheduleErrors.map((s) => (
                    <TableRow key={s.name}>
                      <Td className="whitespace-nowrap">{s.name}</Td>
                      <Td className="whitespace-nowrap tabular-nums text-muted-foreground">{s.lastRunAt ? formatDateTimeEAT(s.lastRunAt) : "—"}</Td>
                      <Td className="max-w-[420px] truncate text-muted-foreground" title={s.lastError}>
                        {s.lastError}
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
