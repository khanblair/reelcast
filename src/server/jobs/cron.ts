/**
 * The production tick request: authenticate, run one tick, log what happened, return the result as JSON.
 * The route (src/app/api/cron/tick/route.ts) is a thin wrapper so this can be tested with a fake runner: a real tick
 * claims and runs real jobs, so no test may call the route itself.
 */
import { NextResponse } from "next/server";
import { stripQueryParams } from "@/server/lib/safe-error";
import { authorized } from "./cron-auth";
import { TICK_HEARTBEAT } from "./heartbeat";
import { runTick, type TickOptions, type TickResult } from "./tick";

export type TickRunner = (opts: TickOptions) => Promise<TickResult>;

const MAX_ERROR_CHARS = 1_000;

/**
 * What the tick did, in the platform log (the HTTP response only goes to pg_net, where nobody reads it):
 * one `[tick] error` line per entry of `result.errors` (cut before any bound query values), then one `[tick]` summary line, but only when work happened or
 * something failed; an idle tick (every minute, usually) logs nothing.
 */
export function logTickResult(result: TickResult, ms: number): void {
  for (const entry of result.errors) console.error("[tick] error", JSON.stringify(stripQueryParams(entry).slice(0, MAX_ERROR_CHARS)));
  const { recovered } = result;
  const worked = recovered.jobs + recovered.tasks + recovered.failedJobs + result.sweepsRun.length + result.jobsRun + result.tasksRun > 0;
  if (!worked && result.errors.length === 0) return;
  console.log(
    "[tick]",
    JSON.stringify({ ms, recovered, sweepsRun: result.sweepsRun, jobsRun: result.jobsRun, tasksRun: result.tasksRun, errors: result.errors.length }),
  );
}

export async function handleTickRequest(req: Request, run: TickRunner = runTick): Promise<Response> {
  if (!authorized(req)) return NextResponse.json({ ok: false }, { status: 401 });
  const budget = Number(new URL(req.url).searchParams.get("budgetMs"));
  const started = performance.now();
  // The only caller that records the heartbeat: it exists to notice that pg_cron stopped calling this route.
  const result = await run({ budgetMs: Number.isFinite(budget) && budget > 0 ? Math.min(budget, 270_000) : 240_000, heartbeat: TICK_HEARTBEAT });
  logTickResult(result, Math.round(performance.now() - started));
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
