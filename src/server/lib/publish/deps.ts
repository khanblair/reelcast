/**
 * Everything the publishing runtime needs from outside its own folder, as one injectable object.
 * Production code uses `defaultDeps()`; tests pass fakes (mock fetch, in-memory notifications, ...)
 * so no test can reach Google, Cloudinary or a user's Telegram.
 */
import type { DbLike } from "@/db/client";
import { destroyCloudinaryAsset } from "@/server/lib/cloudinary";
import { createNotification, type NewNotification } from "@/server/lib/notifications";
import { sendUserNotification, type NotifyEvent } from "@/server/lib/notify";
import { isFileMissing } from "@/server/lib/storageCheck";
import { addYoutubeQuota } from "@/server/lib/youtubeQuota";
import { getValidAccessToken } from "@/server/lib/youtube/tokens";
import type { FetchLike } from "@/server/lib/youtube";

export type PublishDeps = {
  fetch: FetchLike;
  getValidAccessToken: (db: DbLike, youtubeChannelRowId: string) => Promise<{ accessToken: string; channelId: string }>;
  addYoutubeQuota: (db: DbLike, userId: string, units: number) => Promise<number>;
  createNotification: (db: DbLike, n: NewNotification) => Promise<void>;
  sendUserNotification: (db: DbLike, userId: string, event: NotifyEvent, data: Record<string, unknown>) => Promise<void>;
  destroyCloudinaryAsset: (publicId: string, resourceType?: "video" | "image") => Promise<void>;
  isFileMissing: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export function defaultDeps(overrides: Partial<PublishDeps> = {}): PublishDeps {
  // `fetch` is looked up at call time so a test replacing globalThis.fetch is honoured.
  const f: FetchLike = (input, init) => fetch(input, init);
  return {
    fetch: f,
    getValidAccessToken,
    addYoutubeQuota,
    createNotification,
    sendUserNotification,
    destroyCloudinaryAsset: (publicId, resourceType) => destroyCloudinaryAsset(publicId, resourceType ?? "video", f),
    isFileMissing: (url) => isFileMissing(url, f),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    ...overrides,
  };
}

/** Run best-effort side work (accounting, notifications): a failure is logged, never propagated. */
export async function bestEffort(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`[publish] ${label} failed:`, e instanceof Error ? e.message : e);
  }
}
