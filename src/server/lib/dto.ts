/**
 * DTO builders: the ONLY shapes that may leave the server for user-owned records that
 * hold secrets. Raw rows from `users`, `settings`, `youtube_channels` and
 * `platform_settings` must never be returned directly from an RPC handler.
 */
import { and, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { settings, users, youtubeChannels } from "@/db/schema";

type UserRow = typeof users.$inferSelect;
type SettingsRow = typeof settings.$inferSelect;

export type ChannelSummary = {
  youtubeConnected: boolean;
  youtubeChannelId: string | null;
  youtubeChannelName: string | null;
  youtubeOAuthStatus: (typeof youtubeChannels.$inferSelect)["oauthStatus"];
};

/** Connection summary derived from the user's primary channel (replaces the old users.youtube* columns). */
export async function getChannelSummary(db: DbLike, userId: string): Promise<ChannelSummary> {
  const [primary] = await db
    .select({
      channelId: youtubeChannels.channelId,
      channelName: youtubeChannels.channelName,
      oauthStatus: youtubeChannels.oauthStatus,
    })
    .from(youtubeChannels)
    .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.isPrimary, true)))
    .limit(1);
  return {
    youtubeConnected: !!primary,
    youtubeChannelId: primary?.channelId ?? null,
    youtubeChannelName: primary?.channelName ?? null,
    youtubeOAuthStatus: primary?.oauthStatus ?? null,
  };
}

export function userDto(user: UserRow, channel: ChannelSummary) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    imageUrl: user.imageUrl,
    isAdmin: user.isAdmin,
    plan: user.plan,
    createdAt: user.createdAt,
    ...channel,
  };
}

/** Settings as the browser sees them: no secrets, with `has*` flags instead. */
export function settingsDto(row: SettingsRow | null, userId: string, channel: ChannelSummary) {
  const { resendApiKey, deepseekApiKey, ...safe } = row ?? ({} as Partial<SettingsRow>);
  return {
    ...safe,
    id: row?.id ?? null,
    userId,
    notificationsEnabled: row?.notificationsEnabled ?? false,
    hasResendApiKey: !!resendApiKey,
    hasDeepseekApiKey: !!deepseekApiKey,
    youtubeConnected: channel.youtubeConnected,
    youtubeChannelName: channel.youtubeChannelName,
  };
}
