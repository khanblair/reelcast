// Port of convex/aiMessages.ts. Export ONLY rpc definitions from this file.
// `append` (the assistant action persisted turns with it, and it did not check that the session
// belonged to the caller) is now appendAiMessage in lib/accounts/ai.ts. `toolCalls` was never written.
import { z } from "zod";
import { getSessionMessages } from "@/server/lib/accounts/ai";
import { query } from "../rpc/define";

/**
 * The last 100 messages of one of the caller's sessions, chronological. The client passes "skip"
 * when no session is selected; a missing, foreign or unknown session yields [].
 */
export const getContext = query({
  auth: "public",
  input: z.object({ sessionId: z.string().uuid().optional() }),
  handler: async (ctx, args) => {
    if (!ctx.userId || !args.sessionId) return [];
    return getSessionMessages(ctx.db, ctx.userId, args.sessionId, 100);
  },
});
