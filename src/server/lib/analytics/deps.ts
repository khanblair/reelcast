/**
 * Binds the cross-agent contracts (YouTube tokens: agent B, YouTube quota: agent C2) for the
 * analytics code. They are imported lazily so a missing/renamed contract file can never break
 * the job runner or the RPC registry at module load time; it only fails the analytics call.
 */
import type { DbLike } from "@/db/client";

export type YoutubeDeps = {
  getToken: (channelRowId: string) => Promise<{ accessToken: string; channelId: string }>;
  addQuota: (userId: string, units: number) => Promise<unknown>;
  getQuotaUsed: (userId: string) => Promise<number>;
};

export async function loadYoutubeDeps(db: DbLike): Promise<YoutubeDeps> {
  const [tokens, quota] = await Promise.all([
    import("@/server/lib/youtube/tokens"),
    import("@/server/lib/youtubeQuota"),
  ]);
  return {
    getToken: (channelRowId) => tokens.getValidAccessToken(db, channelRowId),
    addQuota: (userId, units) => quota.addYoutubeQuota(db, userId, units),
    getQuotaUsed: (userId) => quota.getYoutubeQuotaUsed(db, userId),
  };
}
