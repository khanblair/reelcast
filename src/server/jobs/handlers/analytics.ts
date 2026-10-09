/**
 * Analytics duties (the Convex version had none: analytics only ran when a user pressed Refresh).
 *
 *  sweep  "analytics.dailyIngest"   every 6h: enqueue the first chunk of a run
 *  task   "analytics.ingestChunk"   processes a bounded chunk of users, then enqueues the next
 *                                   chunk (continuation) with a dedupeKey, so one run never exceeds
 *                                   the host function limit and a crash resumes from the cursor.
 *
 * Idempotent: the ingest upserts a rolling 7-day window, so re-running a chunk (at-least-once
 * delivery) or a user is harmless.
 */
import { loadYoutubeDeps } from "@/server/lib/analytics/deps";
import { ingestUserDailyStats, selectIngestUsers, type UserIngestResult } from "@/server/lib/analytics/dailyIngest";
import type { HandlerCtx, HandlerSet, Sweep } from "../handlers";
import { enqueueTask, type TaskRow } from "../queue";

export const INGEST_KIND = "analytics.ingestChunk";
const SIX_HOURS = 6 * 60 * 60 * 1000;
/** Users per chunk and wall-clock budget per chunk (the host limit is ~300s; stay far below). */
const USERS_PER_CHUNK = 5;
const CHUNK_BUDGET_MS = 90_000;
const CONTINUATION_DELAY_MS = 3_000;

export const dailyIngestSweep: Sweep = {
  name: "analytics.dailyIngest",
  everyMs: SIX_HOURS,
  run: async ({ db, now }: HandlerCtx) => {
    const runId = now.toISOString().slice(0, 13); // one run id per UTC hour
    await enqueueTask(db, {
      kind: INGEST_KIND,
      payload: { runId, cursor: null },
      dedupeKey: `analytics.ingest:${runId}:start`,
    });
  },
};

type IngestPayload = { runId?: unknown; cursor?: unknown };

/** Process one chunk of users after `payload.cursor`, then enqueue the continuation. */
export async function runIngestChunk(task: Pick<TaskRow, "payload">, ctx: HandlerCtx): Promise<{ results: UserIngestResult[]; next: string | null }> {
  const { db } = ctx;
  const payload = task.payload as IngestPayload;
  const runId = typeof payload.runId === "string" ? payload.runId : ctx.now.toISOString().slice(0, 13);
  const cursor = typeof payload.cursor === "string" ? payload.cursor : null;

  const deps = await loadYoutubeDeps(db);
  const users = await selectIngestUsers(db, cursor, USERS_PER_CHUNK);

  const deadline = Date.now() + CHUNK_BUDGET_MS;
  const results: UserIngestResult[] = [];
  let last: string | null = cursor;
  for (const u of users) {
    if (results.length > 0 && Date.now() > deadline) break;
    results.push(await ingestUserDailyStats({ db, ...deps }, u));
    last = u.userId;
  }

  // More users may remain when the page was full or we stopped early on the budget.
  const more = users.length === USERS_PER_CHUNK || results.length < users.length;
  if (more && last && last !== cursor) {
    await enqueueTask(db, {
      kind: INGEST_KIND,
      payload: { runId, cursor: last },
      dedupeKey: `analytics.ingest:${runId}:${last}`,
      runAt: new Date(Date.now() + CONTINUATION_DELAY_MS),
    });
    return { results, next: last };
  }
  return { results, next: null };
}

export const handlers: HandlerSet = {
  tasks: {
    [INGEST_KIND]: async (task, ctx) => {
      const { results } = await runIngestChunk(task, ctx);
      const failed = results.filter((r) => r.status === "auth_failed" || r.status === "forbidden" || r.status === "error").length;
      console.log(`[analytics.dailyIngest] chunk done: users=${results.length} problems=${failed}`);
    },
  },
  sweeps: [dailyIngestSweep],
};
