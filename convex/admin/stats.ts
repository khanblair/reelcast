import { internalQuery, query } from "../_generated/server";

export const getSystemStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    // ── Totals ────────────────────────────────────────────────────────────────
    const allUsers = await ctx.db.query("users").collect();
    const totalUsers = allUsers.length;

    const allVideos = await ctx.db.query("videos").collect();
    const totalVideos = allVideos.length;

    // Sum rawFileSize across every video
    const totalStorageBytes = allVideos.reduce(
      (sum, video) => sum + (video.rawFileSize ?? 0),
      0,
    );

    // ── Time windows ─────────────────────────────────────────────────────────
    const now = Date.now();
    const last24hMs = now - 24 * 60 * 60 * 1000;
    const last7dMs = now - 7 * 24 * 60 * 60 * 1000;

    const startOfTodayUTC = new Date();
    startOfTodayUTC.setUTCHours(0, 0, 0, 0);
    const startOfTodayMs = startOfTodayUTC.getTime();

    // ── Jobs ─────────────────────────────────────────────────────────────────
    const allJobs = await ctx.db.query("jobs").collect();

    const jobsToday = allJobs.filter(
      (j) => j.startedAt !== undefined && j.startedAt >= startOfTodayMs,
    ).length;

    // Publish jobs that have a completedAt (finished one way or another)
    const finishedPublishJobs24h = allJobs.filter(
      (j) =>
        j.type === "publish" &&
        j.completedAt !== undefined &&
        j.completedAt >= last24hMs,
    );
    const publishSuccessRateLast24h = {
      successful: finishedPublishJobs24h.filter((j) => j.status === "completed")
        .length,
      total: finishedPublishJobs24h.length,
    };

    const finishedPublishJobs7d = allJobs.filter(
      (j) =>
        j.type === "publish" &&
        j.completedAt !== undefined &&
        j.completedAt >= last7dMs,
    );
    const publishSuccessRateLast7d = {
      successful: finishedPublishJobs7d.filter((j) => j.status === "completed")
        .length,
      total: finishedPublishJobs7d.length,
    };

    // Failed jobs in the last 24 h — newest first, capped at 50
    const failedJobsLast24h = allJobs
      .filter(
        (j) =>
          j.status === "failed" &&
          j.startedAt !== undefined &&
          j.startedAt >= last24hMs,
      )
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
      .slice(0, 50)
      .map((j) => ({
        _id: j._id,
        userId: j.userId,
        videoId: j.videoId,
        error: j.error,
        startedAt: j.startedAt,
      }));

    // ── Settings ─────────────────────────────────────────────────────────────
    const allSettings = await ctx.db.query("settings").collect();
    const autoPublishActiveCount = allSettings.filter(
      (s) => s.autoPublishEnabled === true,
    ).length;

    return {
      totalUsers,
      totalVideos,
      jobsToday,
      autoPublishActiveCount,
      publishSuccessRateLast24h,
      publishSuccessRateLast7d,
      failedJobsLast24h,
      totalStorageBytes,
    };
  },
});

// ── Public query used by admin UI ─────────────────────────────────────────────
export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const allUsers = await ctx.db.query("users").collect();
    const totalUsers = allUsers.length;
    const youtubeConnected = allUsers.filter((u) => u.youtubeConnected).length;
    const adminCount = allUsers.filter((u) => u.isAdmin).length;

    const allVideos = await ctx.db.query("videos").collect();
    const totalVideos = allVideos.length;
    const totalStorageBytes = allVideos.reduce(
      (s, v) => s + (v.rawFileSize ?? 0),
      0,
    );
    const publishedVideos = allVideos.filter(
      (v) => v.status === "published",
    ).length;

    const now = Date.now();
    const last24h = now - 86_400_000;

    const startOfTodayUTC = new Date();
    startOfTodayUTC.setUTCHours(0, 0, 0, 0);
    const startOfTodayMs = startOfTodayUTC.getTime();

    const allJobs = await ctx.db.query("jobs").collect();
    const jobsToday = allJobs.filter(
      (j) => (j.startedAt ?? 0) >= startOfTodayMs,
    ).length;

    const recentPublishJobs = allJobs.filter(
      (j) => j.type === "publish" && (j.completedAt ?? 0) >= last24h,
    );
    const successRate24h =
      recentPublishJobs.length > 0
        ? recentPublishJobs.filter((j) => j.status === "completed").length /
          recentPublishJobs.length
        : null;

    const allSettings = await ctx.db.query("settings").collect();
    const autoPublishActive = allSettings.filter(
      (s) => s.autoPublishEnabled,
    ).length;

    return {
      totalUsers,
      youtubeConnected,
      adminCount,
      totalVideos,
      publishedVideos,
      totalStorageBytes,
      jobsToday,
      successRate24h,
      autoPublishActive,
    };
  },
});
