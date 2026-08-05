import { query } from "../_generated/server";

/**
 * Per-user storage breakdown, sorted by totalBytes desc.
 * Only users with at least one video are included.
 */
export const getPerUserBreakdown = query({
  args: {},
  handler: async (ctx) => {
    const allUsers = await ctx.db.query("users").collect();

    const rows = await Promise.all(
      allUsers.map(async (user) => {
        const videos = await ctx.db
          .query("videos")
          .withIndex("by_user", (q) => q.eq("userId", user._id))
          .collect();

        const totalBytes = videos.reduce((s, v) => s + (v.rawFileSize ?? 0), 0);
        return {
          userId: user._id,
          email: user.email,
          name: user.name,
          plan: user.plan ?? "free",
          totalBytes,
          videoCount: videos.length,
        };
      }),
    );

    return rows
      .filter((r) => r.videoCount > 0)
      .sort((a, b) => b.totalBytes - a.totalBytes);
  },
});
