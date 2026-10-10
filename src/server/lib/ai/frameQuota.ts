/**
 * Metering for the Gemini calls that read video frames outside `metadata.generateForUpload`
 * (`actions.generateCaptions`, `actions.generateThumbnail`).
 *
 * Counter: `metadataGenerated`. It is the only existing counter that is both (a) about Gemini analysing a video's
 * frames, the same kind and size of call as metadata generation, and (b) non-zero for the free plan. The alternatives
 * do not fit: `aiMessagesUsed` is the DeepSeek chat allowance and is 0 on free (it would switch both features off
 * for free users), `veoGenerated` is video generation (0 on free), `videosUploaded` counts uploads. Limits live in
 * src/lib/plan-limits.ts: free 5 / month, pro and elite unlimited. So in practice only free users are gated, and
 * they spend ONE shared allowance on metadata, captions and thumbnails. A dedicated counter needs a
 * `usage_ledger` column (a migration), which is a follow-up.
 *
 * Same contract as the metadata action: consume BEFORE any paid work (atomic, one statement), fail with the
 * PLAN_LIMIT_EXCEEDED rpc error, give the unit back when the work did not happen.
 */
import type { DbLike } from "@/db/client";
import { isPlanLimitError } from "@/server/lib/generation/common";
import { consumeQuota, refundQuota } from "@/server/lib/usage";
import { RpcError } from "@/server/rpc/errors";

export const FRAME_AI_LIMIT_MESSAGE =
  "AI limit reached for your plan: captions, thumbnails and metadata generation share one monthly allowance. Upgrade for more.";

export type FrameAiMeter = {
  /** Give the unit back. Safe to call more than once: only the first call refunds. */
  refund: () => Promise<void>;
};

/**
 * Spend one unit or throw `RpcError("PLAN_LIMIT_EXCEEDED")`. Pass the caller's plan (`ctx.user.plan`, read fresh on
 * every request) so the whole check is the single consume statement.
 */
export async function meterFrameAi(db: DbLike, userId: string, plan: string): Promise<FrameAiMeter> {
  try {
    await consumeQuota(db, userId, "metadataGenerated", plan);
  } catch (e) {
    if (isPlanLimitError(e)) throw new RpcError("PLAN_LIMIT_EXCEEDED", FRAME_AI_LIMIT_MESSAGE);
    throw e;
  }
  let spent = true;
  return {
    refund: async () => {
      if (!spent) return;
      spent = false;
      await refundQuota(db, userId, "metadataGenerated").catch(() => {});
    },
  };
}
