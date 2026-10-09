/**
 * Handler registry for the job runner. Each domain owns one file under ./handlers/ and
 * exports a `HandlerSet`; this file just merges them. Handlers must be IDEMPOTENT:
 * the queue is at-least-once (a worker that dies mid-run is retried).
 */
import type { DbLike } from "@/db/client";
import type { JobRow, JobType, TaskRow } from "./queue";

import { handlers as publish } from "./handlers/publish";
import { handlers as generation } from "./handlers/generation";
import { handlers as billing } from "./handlers/billing";
import { handlers as analytics } from "./handlers/analytics";
import { handlers as system } from "./handlers/system";

export type HandlerCtx = {
  db: DbLike;
  now: Date;
  /**
   * Epoch ms after which the tick stops STARTING work (tick start + budget). A handler may run up
   * to ~55s past it (host limit is ~300s vs a 240s default budget), so long handlers should size
   * their own work from it, e.g. budget = deadline - now - 10s, and `deferMs` when little is left.
   * Undefined when a handler is invoked outside a tick (tests).
   */
  deadline?: number;
};

/** Throw `new NonRetryableError(msg)` to fail a job/task permanently without further attempts. */
export class NonRetryableError extends Error {
  readonly retryable = false;
}

/**
 * Return nothing / `{ metadata }` when done. Return `{ deferMs }` when the work is not finished and
 * should run again after that delay without using a retry attempt (resume state goes in `metadata`).
 */
export type JobResult = void | { metadata?: unknown } | { deferMs: number; metadata?: unknown };
export type JobHandler = (job: JobRow, ctx: HandlerCtx) => Promise<JobResult>;
/** Return `{ rescheduleInMs }` to poll again later (does not count as a failure). */
export type TaskHandler = (task: TaskRow, ctx: HandlerCtx) => Promise<void | { rescheduleInMs: number; payload?: Record<string, unknown> }>;

/** A periodic duty (the Convex `crons` equivalent). Runs at most once per `everyMs` across all workers. */
export type Sweep = { name: string; everyMs: number; run: (ctx: HandlerCtx) => Promise<void> };

/**
 * Called once when a job fails for good: retries exhausted, a NonRetryableError, or a worker that
 * died on its last attempt and was given up on by stale recovery. Use it to leave the owning
 * record (e.g. the video) in a consistent failed state. Must be idempotent; errors are logged.
 */
export type JobFailedHook = (job: JobRow, error: string, ctx: HandlerCtx) => Promise<void>;

export type HandlerSet = {
  jobs?: Partial<Record<JobType, JobHandler>>;
  onJobFailed?: Partial<Record<JobType, JobFailedHook>>;
  tasks?: Record<string, TaskHandler>;
  sweeps?: Sweep[];
};

const sets: HandlerSet[] = [publish, generation, billing, analytics, system];

export const jobHandlers: Partial<Record<JobType, JobHandler>> = Object.assign({}, ...sets.map((s) => s.jobs ?? {}));
export const jobFailedHooks: Partial<Record<JobType, JobFailedHook>> = Object.assign({}, ...sets.map((s) => s.onJobFailed ?? {}));
export const taskHandlers: Record<string, TaskHandler> = Object.assign({}, ...sets.map((s) => s.tasks ?? {}));
export const sweeps: Sweep[] = sets.flatMap((s) => s.sweeps ?? []);
