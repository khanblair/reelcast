// Port of convex/actions/deleteVideo.ts. Export ONLY rpc definitions from this file.
import { z } from "zod";
import { deleteVideoForUser } from "@/server/lib/publish/delete";
import { action } from "../../rpc/define";

/** Delete one of the caller's videos (storage files best-effort, then the rows). Someone else's video is NOT_FOUND. */
export const deleteVideo = action({
  input: z.object({ videoId: z.string().uuid() }),
  handler: async (ctx, { videoId }) => {
    await deleteVideoForUser(ctx.db, ctx.userId, videoId);
  },
});
