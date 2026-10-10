// Admin-only. Job-runner health: queue depth, failed tasks, failing sweeps and the tick heartbeat (scaling ladder M-3, Q-3a).
// The SQL lives in src/server/lib/queue-health.ts (a module file may export only rpc definitions).
import { query } from "../../rpc/define";
import { getFailedTasks, getQueueDepth, getScheduleHealth } from "../../lib/queue-health";

/** How many failed tasks the page lists. */
const FAILED_TASK_LIMIT = 20;

/**
 * Everything an admin needs to see that background work is flowing, in THREE statements however much data there is
 * (queue depth; failed tasks; heartbeat + failing sweeps):
 *  - `queue`          jobs and tasks: due-pending, scheduled, processing, failed in the last 24 h, oldest due age
 *  - `failedTasks`    the 20 most recent failed tasks (tasks have no UI: nobody saw them fail), error text scrubbed
 *  - `tick`           the production tick heartbeat, with `stale` computed here so the browser needs no thresholds
 *  - `scheduleErrors` sweeps whose last run failed (a sweep clears its error when it next succeeds)
 */
export const getHealth = query({
  auth: "admin",
  handler: async (ctx) => {
    // One after the other on purpose: production has one connection, so concurrent statements would only queue.
    const queue = await getQueueDepth(ctx.db);
    const failedTasks = await getFailedTasks(ctx.db, FAILED_TASK_LIMIT);
    const { tick, scheduleErrors } = await getScheduleHealth(ctx.db);
    return { queue, failedTasks, tick, scheduleErrors };
  },
});
