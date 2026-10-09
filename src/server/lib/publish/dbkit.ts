/** Helpers for DB-backed publish tests (rows are created inside rolled-back transactions or cleaned up by the test). */
import { randomUUID } from "node:crypto";
import type { DbLike } from "@/db/client";
import { jobs, videos, youtubeChannels } from "@/db/schema";
import type { NewNotification } from "@/server/lib/notifications";
import type { NotifyEvent } from "@/server/lib/notify";
import type { JobRow } from "@/server/jobs/queue";
import { defaultDeps, type PublishDeps } from "./deps";
import { CLOUD_URL, type FakeWorld } from "./testkit";

export type Spies = {
  quota: [string, number][];
  notifications: NewNotification[];
  messages: { event: NotifyEvent; data: Record<string, unknown> }[];
  destroyed: string[];
  tokenCalls: string[];
};

export function makeDeps(world: FakeWorld, over: Partial<PublishDeps> = {}): { deps: PublishDeps; spies: Spies } {
  const spies: Spies = { quota: [], notifications: [], messages: [], destroyed: [], tokenCalls: [] };
  const deps: PublishDeps = defaultDeps({
    fetch: world.fetch,
    getValidAccessToken: async (_db, id) => {
      spies.tokenCalls.push(id);
      return { accessToken: "tok", channelId: "UC_fake" };
    },
    addYoutubeQuota: async (_db, userId, units) => {
      spies.quota.push([userId, units]);
      return units;
    },
    createNotification: async (_db, n) => {
      spies.notifications.push(n);
    },
    sendUserNotification: async (_db, _userId, event, data) => {
      spies.messages.push({ event, data });
    },
    destroyCloudinaryAsset: async (publicId) => {
      spies.destroyed.push(publicId);
    },
    isFileMissing: async () => false,
    sleep: async () => {},
    now: world.now,
    ...over,
  });
  return { deps, spies };
}

export async function mkChannel(db: DbLike, userId: string, over: Partial<typeof youtubeChannels.$inferInsert> = {}) {
  const [c] = await db
    .insert(youtubeChannels)
    .values({ userId, channelId: `UC_test_${randomUUID()}`, accessToken: "x", tokenExpiry: new Date(Date.now() + 3_600_000), isPrimary: false, ...over })
    .returning();
  return c;
}

export async function mkVideo(db: DbLike, userId: string, over: Partial<typeof videos.$inferInsert> = {}) {
  const [v] = await db
    .insert(videos)
    .values({ userId, title: "__test publish video", rawFileKey: CLOUD_URL, rawFileSize: 1, status: "publishing", ...over })
    .returning();
  return v;
}

/** A job row as the runner hands it to the handler (already claimed: attempts counts this run). */
export async function mkJob(db: DbLike, userId: string, videoId: string, over: Partial<typeof jobs.$inferInsert> = {}): Promise<JobRow> {
  const [j] = await db
    .insert(jobs)
    .values({ userId, videoId, type: "publish", status: "processing", attempts: 1, maxAttempts: 3, lockedAt: new Date(), ...over })
    .returning();
  return j;
}
