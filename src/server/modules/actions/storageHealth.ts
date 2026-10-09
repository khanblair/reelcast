// Port of convex/actions/storageHealth.ts. Export ONLY rpc definitions from this file.
import { checkTargets, listPublishableTargets } from "@/server/lib/publish/storage";
import { defaultDeps } from "@/server/lib/publish/deps";
import { action } from "../../rpc/define";

const BUDGET_MS = 25_000;

/** HEAD-check the caller's ready + scheduled videos against Cloudinary and record the result. */
export const checkQueueStorageHealth = action({
  handler: async (ctx) => {
    const deadline = Date.now() + BUDGET_MS;
    const targets = await listPublishableTargets(ctx.db, { userId: ctx.userId });
    return checkTargets(ctx.db, targets, defaultDeps().isFileMissing, { deadline });
  },
});

/** Admin: the same check across every user (least recently checked first; time-boxed, call again to continue). */
export const checkAllUsersStorageHealth = action({
  auth: "admin",
  handler: async (ctx) => {
    const deadline = Date.now() + BUDGET_MS;
    const targets = await listPublishableTargets(ctx.db, { limit: 2000 });
    return checkTargets(ctx.db, targets, defaultDeps().isFileMissing, { deadline });
  },
});
