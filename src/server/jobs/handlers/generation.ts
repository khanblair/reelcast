/**
 * AI & generation runtime handlers (agent C2):
 *   job   generation          Veo text-to-video state machine / Gemini metadata for uploaded videos
 *   task  metadata.generate   scheduled (or handed-over manual) metadata generation
 *   task  digest.batch        weekly digest, one page of users per run
 *   sweep weekly-digest       every 15 min; opens the Sunday 08:00 UTC digest window once per week
 * The logic lives in src/server/lib/generation/*; this file only registers it.
 */
import type { HandlerSet } from "../handlers";
import { DIGEST_BATCH_KIND, DIGEST_SWEEP_EVERY_MS, DIGEST_SWEEP_NAME, runDigestBatchTask, runDigestSweep } from "@/server/lib/generation/digest";
import { onGenerationJobFailed, runGenerationJob } from "@/server/lib/generation/generationJob";
import { runMetadataTask } from "@/server/lib/generation/metadataTask";

export const handlers: HandlerSet = {
  jobs: {
    generation: (job, ctx) => runGenerationJob(job, ctx),
  },
  onJobFailed: { generation: onGenerationJobFailed },
  tasks: {
    "metadata.generate": (task, ctx) => runMetadataTask(task, ctx),
    [DIGEST_BATCH_KIND]: (task, ctx) => runDigestBatchTask(task, ctx),
  },
  sweeps: [{ name: DIGEST_SWEEP_NAME, everyMs: DIGEST_SWEEP_EVERY_MS, run: runDigestSweep }],
};
