import { query } from "../_generated/server";
import { getCurrentUserOrThrow } from "../lib/auth";

async function requireAdmin(ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> }; db: any }) {
  const identity = await getCurrentUserOrThrow(ctx as any);
  const user = await ctx.db
    .query("users")
    .withIndex("by_supabase_id", (q: any) => q.eq("supabaseId", identity.subject))
    .unique();
  if (!user?.isAdmin) throw new Error("Admin required");
}

// Platform-wide storage health — every ready/scheduled video's last known
// Cloudinary file status, from the storageMissing/storageCheckedAt fields
// set by the (per-user or admin-triggered) storage health check actions.
export const getStorageHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx as any);

    const all = await ctx.db.query("videos").collect();
    const relevant = all.filter((v: any) => v.status === "ready" || v.status === "scheduled");

    const missing = relevant.filter((v: any) => v.storageMissing === true);
    const healthy = relevant.filter((v: any) => v.storageMissing === false);
    const uncheckedCount = relevant.length - missing.length - healthy.length;

    const userIds = [...new Set(missing.map((v: any) => v.userId))];
    const users = await Promise.all(userIds.map((id) => ctx.db.get(id)));
    const emailByUserId = new Map(users.filter(Boolean).map((u: any) => [u._id, u.email]));

    return {
      totalRelevant: relevant.length,
      healthyCount: healthy.length,
      missingCount: missing.length,
      uncheckedCount,
      missingVideos: missing
        .map((v: any) => ({
          videoId: v._id,
          title: v.aiTitle ?? v.title,
          userEmail: emailByUserId.get(v.userId) ?? "unknown",
          status: v.status,
          checkedAt: v.storageCheckedAt ?? null,
        }))
        .sort((a: any, b: any) => (b.checkedAt ?? 0) - (a.checkedAt ?? 0)),
    };
  },
});

// Platform-wide YouTube token health — every connected channel (primary and
// secondary) across every user, from the youtubeChannels table.
export const getTokenHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx as any);

    const channels = await ctx.db.query("youtubeChannels").collect();
    const userIds = [...new Set(channels.map((c: any) => c.userId))];
    const users = await Promise.all(userIds.map((id) => ctx.db.get(id)));
    const emailByUserId = new Map(users.filter(Boolean).map((u: any) => [u._id, u.email]));

    const rows = channels.map((c: any) => ({
      channelId: c.channelId,
      channelName: c.channelName ?? c.channelId,
      userEmail: emailByUserId.get(c.userId) ?? "unknown",
      isPrimary: c.isPrimary ?? false,
      oauthStatus: c.oauthStatus ?? "unknown",
      tokenExpiry: c.tokenExpiry,
    }));

    const counts = { connected: 0, token_expired: 0, revoked: 0, unknown: 0 } as Record<string, number>;
    for (const r of rows) counts[r.oauthStatus] = (counts[r.oauthStatus] ?? 0) + 1;

    return {
      total: rows.length,
      counts,
      rows: rows.sort((a, b) => a.userEmail.localeCompare(b.userEmail)),
    };
  },
});
