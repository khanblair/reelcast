/**
 * When may a LOCAL process run the job runner?
 *
 * Dev and production can share one database (`DATABASE_URL` in `.env.local` may be the production one), so a
 * `next dev` server must not start draining the queue by itself: it would claim and run real users' jobs with
 * whatever code is on this machine. Local ticking is therefore opt-in with `DEV_TICK=1`. In production the
 * tick comes from pg_cron (`/api/cron/tick`) and from `kickRunner`.
 *
 * Pure functions of an env object, with no imports, so they can be unit-tested and imported from anywhere
 * (including `instrumentation.ts`, which must not load the database layer eagerly).
 */
export type DevTickEnv = { NODE_ENV?: string; DEV_TICK?: string };

/** The in-process 5-second ticker (`src/instrumentation.ts`): `next dev` only, and only when asked for. */
export function shouldRunDevTick(env: DevTickEnv): boolean {
  return env.NODE_ENV === "development" && env.DEV_TICK === "1";
}

/** `kickRunner` (run a tick right after a user action): always in production, elsewhere only when asked for. */
export function shouldKick(env: DevTickEnv): boolean {
  return env.NODE_ENV === "production" || env.DEV_TICK === "1";
}

/** The one line `next dev` prints when the ticker stays off. */
export const DEV_TICK_OFF_MESSAGE =
  "[dev tick] off: the job runner is not running locally (DATABASE_URL may be the production database). Set DEV_TICK=1 in .env.local to run it.";
