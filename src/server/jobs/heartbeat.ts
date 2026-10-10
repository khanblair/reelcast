/**
 * The tick heartbeat: one `job_schedules` row, written at the end of every tick, that says "the job runner ran at X".
 * If the scheduler (pg_cron) or the app stops, the row stops advancing and its age is the alarm (a later health endpoint
 * reads it with getTickHeartbeat).
 *
 * It lives in job_schedules next to the sweep clocks and the `digest:<user>:<week>` markers. It is not a sweep: sweeps are
 * found and claimed strictly BY NAME from the list passed to runTick (see dueSweeps / claimSweep in tick.ts), and no
 * registered sweep has this name (tick.test.ts asserts it), so nothing ever tries to run or lease this row.
 */
import { eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { jobSchedules } from "@/db/schema";
import { stripQueryParams } from "@/server/lib/safe-error";

export const TICK_HEARTBEAT = "tick.heartbeat";

const MAX_ERROR_CHARS = 300;

/** A short summary of a tick's errors for `last_error` (cut before any bound query values), or null when there were none. */
export function summarizeTickErrors(errors: string[]): string | null {
  if (errors.length === 0) return null;
  return `${errors.length} error${errors.length === 1 ? "" : "s"}: ${stripQueryParams(errors[0])}`.slice(0, MAX_ERROR_CHARS);
}

/**
 * Record "a tick finished just now" in ONE statement (insert-or-update on the primary key). `last_run_at` is the database
 * clock, like the sweeps' clocks, so readers need no clock agreement with the app server.
 */
export async function writeTickHeartbeat(db: DbLike, name: string, errors: string[]): Promise<void> {
  const lastError = summarizeTickErrors(errors);
  await db
    .insert(jobSchedules)
    .values({ name, lastRunAt: sql`now()`, lastError })
    .onConflictDoUpdate({ target: jobSchedules.name, set: { lastRunAt: sql`now()`, lastError } });
}

export type TickHeartbeat = {
  /** When the last tick finished, or null if none has ever been recorded. */
  lastRunAt: Date | null;
  /** Database-clock milliseconds since then, or null if none has ever been recorded. */
  ageMs: number | null;
};

/** Read the heartbeat in ONE statement; the age is computed by the database so app/db clock skew cannot fake it. */
export async function getTickHeartbeat(db: DbLike, name: string = TICK_HEARTBEAT): Promise<TickHeartbeat> {
  const [row] = await db
    .select({
      lastRunAt: jobSchedules.lastRunAt,
      ageMs: sql<number | null>`(extract(epoch from (now() - ${jobSchedules.lastRunAt})) * 1000)::float8`,
    })
    .from(jobSchedules)
    .where(eq(jobSchedules.name, name))
    .limit(1);
  if (!row || row.lastRunAt === null) return { lastRunAt: null, ageMs: null };
  return { lastRunAt: row.lastRunAt, ageMs: row.ageMs === null ? null : Number(row.ageMs) };
}
