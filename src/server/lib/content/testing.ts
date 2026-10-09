/**
 * Fixtures for the content module tests. `inRolledBackTx` (src/server/testing.ts) gives every test
 * its own synthetic user inside a transaction that is always rolled back, so assertions over a
 * user's whole data set are exact. Use `makeUser()` for a second user in ownership tests.
 */
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";

export type VideoInsert = typeof videos.$inferInsert;

export async function insertVideo(tx: DbLike, userId: string, over: Partial<VideoInsert> = {}) {
  const [row] = await tx
    .insert(videos)
    .values({ userId, title: "t", rawFileKey: "https://res.cloudinary.com/demo/video/upload/v1/x.mp4", rawFileSize: 10, ...over })
    .returning();
  return row;
}
