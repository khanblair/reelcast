/**
 * `GET /api/health` (scaling ladder M-4): one URL an external uptime pinger can poll.
 *
 *   status "ok"        the database answers, the tick heartbeat is fresh, no required variable is missing
 *   status "degraded"  it works but something needs a human: no heartbeat has ever been recorded, or a required
 *                      environment variable is missing/unusable (M-5). HTTP 200, so a pinger does not page for it.
 *   status "down"      the database does not answer `select 1` within DB_TIMEOUT_MS (or errors), or the heartbeat is
 *                      older than TICK_STALE_MS (the scheduler stopped). HTTP 503.
 *
 * Without the cron secret the body is ONLY `{"status": ...}`. With it (`Authorization: Bearer <CRON_SECRET>`) the body
 * adds the details: database latency, tick age, queue depth, and the NAMES of missing environment variables. No
 * environment value is ever returned, and database errors are reduced to "timeout" | "error".
 *
 * Statements: `select 1`, the heartbeat read, and (secret only) the queue depth: 2 without the secret, 3 with it.
 * Auth is checked first, so an anonymous caller never triggers the aggregate. The heartbeat read is kept apart from
 * the ping so the ping is the literal `select 1` the contract names, and so `getTickHeartbeat` stays the one reader of
 * that row (the whole DB phase shares one timer, so a slow database still answers within DB_TIMEOUT_MS).
 */
import { sql } from "drizzle-orm";
import { db as defaultDb, type DbLike } from "@/db/client";
import { hasCronSecret } from "@/server/jobs/cron-auth";
import { TICK_HEARTBEAT, getTickHeartbeat } from "@/server/jobs/heartbeat";
import { checkEnv, type Env, type EnvCheck } from "./env-check";
import { getQueueDepth, TICK_STALE_MS, type QueueDepth } from "./queue-health";

/** The database has this long, for everything the check runs. A hung statement would otherwise wait for the server's 120 s timeout. */
export const DB_TIMEOUT_MS = 5_000;

export type HealthStatus = "ok" | "degraded" | "down";

export type HealthDetails = {
  db: { ok: boolean; ms: number | null; error?: "timeout" | "error" };
  tick: { lastRunAt: Date | null; ageMs: number | null; stale: boolean } | null;
  queue: QueueDepth | null;
  env: EnvCheck;
};

export type HealthReport = { status: HealthStatus; details: HealthDetails };

/** The whole mapping from facts to status. `tickAgeMs` null = no heartbeat row (or nothing was read). */
export function statusFor(facts: { dbOk: boolean; tickAgeMs: number | null; envMissing: number }): HealthStatus {
  if (!facts.dbOk) return "down";
  if (facts.tickAgeMs !== null && facts.tickAgeMs > TICK_STALE_MS) return "down";
  if (facts.tickAgeMs === null || facts.envMissing > 0) return "degraded";
  return "ok";
}

export const httpStatusFor = (status: HealthStatus): number => (status === "down" ? 503 : 200);

export type HealthDeps = {
  db: DbLike;
  env: Env;
  /** Total time for the database phase. */
  timeoutMs: number;
  /** Which job_schedules row holds the tick heartbeat. Tests use their own row so they never touch the real one. */
  heartbeatName: string;
  /** Also read the queue depth (3rd statement). Only for callers that hold the cron secret. */
  withQueue: boolean;
};

export async function collectHealth(deps: HealthDeps): Promise<HealthReport> {
  const started = performance.now();
  const seen: { dbMs: number | null; tick: { lastRunAt: Date | null; ageMs: number | null } | null; queue: QueueDepth | null } = { dbMs: null, tick: null, queue: null };

  const work = (async () => {
    await deps.db.execute(sql`select 1`);
    seen.dbMs = Math.round(performance.now() - started);
    seen.tick = await getTickHeartbeat(deps.db, deps.heartbeatName);
    if (deps.withQueue) seen.queue = await getQueueDepth(deps.db);
    return "done" as const;
  })();

  // If the timer wins, `work` is abandoned and may still fail later. Promise.race keeps a rejection handler on it, so that
  // late failure is swallowed rather than reported as an unhandled rejection (health.test.ts guards this).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.timeoutMs);
  });
  let error: "timeout" | "error" | undefined;
  try {
    if ((await Promise.race([work, timedOut])) === "timeout") error = "timeout";
  } catch {
    error = "error"; // the message is dropped on purpose: a database error can name the pooler host or user
  } finally {
    clearTimeout(timer);
  }

  const env = checkEnv(deps.env);
  const raw = error ? null : seen.tick; // (the heartbeat age is a float: millisecond precision is plenty in the report)
  const tick = raw ? { lastRunAt: raw.lastRunAt, ageMs: raw.ageMs === null ? null : Math.round(raw.ageMs), stale: raw.ageMs !== null && raw.ageMs > TICK_STALE_MS } : null;
  const status = statusFor({ dbOk: !error, tickAgeMs: raw?.ageMs ?? null, envMissing: env.missing.length });
  return {
    status,
    details: { db: error ? { ok: false, ms: null, error } : { ok: true, ms: seen.dbMs }, tick, queue: error ? null : seen.queue, env },
  };
}

/**
 * Anonymous callers share ONE result for this long, per instance. The endpoint is public and every uncached call runs
 * statements on the production pool of a single connection, so without this anyone could keep the app's only database
 * connection busy by hammering the URL. A pinger polling every minute still sees fresh data; the answer is at most
 * this old. Callers holding the cron secret are never cached.
 */
export const ANONYMOUS_CACHE_MS = 10_000;
const anonymousCache = new WeakMap<object, { at: number; report: Promise<HealthReport> }>();

/** The route's work, with its inputs injectable for tests. Defaults are the real database, environment and heartbeat row. */
export async function handleHealthRequest(
  req: Request,
  deps: Partial<HealthDeps> & {
    /** How long an anonymous result is reused. Default: ANONYMOUS_CACHE_MS on the real database, 0 when a test injects `db`. */
    anonymousCacheMs?: number;
    nowMs?: () => number;
  } = {},
): Promise<Response> {
  const env = deps.env ?? process.env;
  const detailed = hasCronSecret(req, env.CRON_SECRET);
  const db = deps.db ?? defaultDb;
  const run = (withQueue: boolean) =>
    collectHealth({ db, env, timeoutMs: deps.timeoutMs ?? DB_TIMEOUT_MS, heartbeatName: deps.heartbeatName ?? TICK_HEARTBEAT, withQueue });

  let report: HealthReport;
  if (detailed) {
    report = await run(true);
  } else {
    const ttl = deps.anonymousCacheMs ?? (deps.db ? 0 : ANONYMOUS_CACHE_MS);
    const now = (deps.nowMs ?? Date.now)();
    const hit = anonymousCache.get(db);
    if (ttl > 0 && hit && now - hit.at < ttl) {
      report = await hit.report;
    } else {
      const pending = run(false);
      if (ttl > 0) anonymousCache.set(db, { at: now, report: pending });
      report = await pending;
    }
  }
  const body = detailed ? { status: report.status, ...report.details } : { status: report.status };
  return Response.json(body, { status: httpStatusFor(report.status), headers: { "Cache-Control": "no-store" } });
}
