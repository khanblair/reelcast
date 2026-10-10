import type { HandlerSet } from "../handlers";
import { runAutoPublish } from "@/server/lib/publish/autoPublish";
import { recoverAutoPublishChains } from "@/server/lib/publish/autoPublishChain";
import { processDueSchedules, reconcilePublishing } from "@/server/lib/publish/sweeps";
import { runPublishJob, type PublishCtx } from "@/server/lib/publish/run";

/**
 * Publishing runtime (agent C1).
 *  - job   `publish`            upload one video to YouTube (resumable, idempotent)
 *  - task  `autoPublish.run`    one auto-publish batch for a user, then schedules the next run
 *  - sweep `publish.dueSchedules` every minute: scheduled videos that are due become publish jobs
 *  - sweep `publish.reconcile`    every 5 minutes: repair videos stuck in "publishing"
 *  - sweep `autoPublish.recover`  every 15 minutes: restart the auto-publish chain of a user whose run is 10+ min overdue
 *                                 and has no live task (a chain that died). At most 20 per run.
 */
export const handlers: HandlerSet = {
  jobs: {
    // `deadline` is optional on the runner's context; when the runner supplies it the job leaves the tick enough time.
    publish: (job, ctx) => runPublishJob(job, ctx as PublishCtx),
  },
  tasks: {
    "autoPublish.run": (task, ctx) => runAutoPublish(task, ctx),
  },
  sweeps: [
    {
      name: "publish.dueSchedules",
      everyMs: 60_000,
      run: async ({ db }) => {
        await processDueSchedules(db);
      },
    },
    {
      name: "publish.reconcile",
      everyMs: 5 * 60_000,
      run: async ({ db }) => {
        await reconcilePublishing(db);
      },
    },
    {
      name: "autoPublish.recover",
      everyMs: 15 * 60_000,
      run: async ({ db, now }) => {
        const r = await recoverAutoPublishChains(db, now);
        // Reported through job_schedules.last_error; the users that could be restarted already were.
        if (r.failed.length > 0) throw new Error(`autoPublish.recover: ${r.failed.length} of ${r.found} restarts failed: ${r.failed[0]}`);
      },
    },
  ],
};
