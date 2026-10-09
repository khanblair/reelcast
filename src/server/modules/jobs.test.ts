import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { jobs, videos } from "@/db/schema";
import { insertVideo } from "@/server/lib/content/testing";
import { callRpc, inRolledBackTx } from "@/server/testing";

setDefaultTimeout(120_000);

type W = Record<string, unknown>;

describe("jobs.create", () => {
  test("generation: owner-scoped, and a second create returns the same job", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const v = await insertVideo(tx, user.id, { status: "queued", sourceType: "generate" });

      await expect(callRpc("jobs.create", { videoId: v.id, type: "generation" }, { user: await makeUser(), tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("jobs.create", { videoId: crypto.randomUUID(), type: "generation" }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });

      const first = (await callRpc("jobs.create", { videoId: v.id, type: "generation" }, { user, tx })) as string;
      const second = (await callRpc("jobs.create", { videoId: v.id, type: "generation" }, { user, tx })) as string;
      expect(second).toBe(first);
      const rows = await tx.select().from(jobs).where(and(eq(jobs.videoId, v.id), eq(jobs.type, "generation")));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first, userId: user.id, status: "pending" });
      expect((await tx.select().from(videos).where(eq(videos.id, v.id)))[0].status).toBe("queued"); // untouched
    });
  });

  test("publish: claims a ready/scheduled video once; repeats return the same job", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const ready = await insertVideo(tx, user.id, { status: "ready" });
      const scheduled = await insertVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: new Date(Date.now() + 60_000) });

      for (const v of [ready, scheduled]) {
        const first = (await callRpc("jobs.create", { videoId: v.id, type: "publish" }, { user, tx })) as string;
        const second = (await callRpc("jobs.create", { videoId: v.id, type: "publish" }, { user, tx })) as string;
        expect(second).toBe(first);
        expect(await tx.select().from(jobs).where(and(eq(jobs.videoId, v.id), eq(jobs.type, "publish")))).toHaveLength(1);
        expect((await tx.select().from(videos).where(eq(videos.id, v.id)))[0].status).toBe("publishing");
      }
      await expect(callRpc("jobs.create", { videoId: ready.id, type: "publish" }, { user: await makeUser(), tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  test("publish is refused for drafts, videos already on YouTube, and videos whose file is gone", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const draft = await insertVideo(tx, user.id);
      const published = await insertVideo(tx, user.id, { status: "published", publishedVideoId: "yt123" });
      const destroyed = await insertVideo(tx, user.id, { status: "failed", cloudinaryDeletedAt: new Date() });
      await expect(callRpc("jobs.create", { videoId: draft.id, type: "publish" }, { user, tx })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: 'Cannot publish video with status "draft". Video must be "ready" or "scheduled".',
      });
      await expect(callRpc("jobs.create", { videoId: published.id, type: "publish" }, { user, tx })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "This video has already been published to YouTube — nothing to retry.",
      });
      await expect(callRpc("jobs.create", { videoId: destroyed.id, type: "publish" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await tx.select().from(jobs).where(eq(jobs.userId, user.id))).toHaveLength(0);
      expect((await tx.select().from(videos).where(eq(videos.id, draft.id)))[0].status).toBe("draft");
    });
  });
});

describe("jobs.list", () => {
  test("returns only my jobs, newest first, without queue internals", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const v = await insertVideo(tx, user.id);
      const [older] = await tx.insert(jobs).values({ userId: user.id, videoId: v.id, type: "generation", status: "completed", createdAt: new Date("2026-01-01T00:00:00Z"), metadata: { secret: "state" } }).returning();
      const [newer] = await tx.insert(jobs).values({ userId: user.id, videoId: v.id, type: "publish", status: "failed", error: "boom", createdAt: new Date("2026-02-01T00:00:00Z") }).returning();

      const mine = (await callRpc("jobs.list", {}, { user, tx })) as W[];
      expect(mine.map((j) => j._id)).toEqual([newer.id, older.id]);
      const row = mine[0];
      expect(row).toMatchObject({ videoId: v.id, userId: user.id, type: "publish", status: "failed", error: "boom" });
      for (const k of ["metadata", "attempts", "maxAttempts", "lockedAt", "runAt"]) expect(k in row).toBe(false);

      expect(await callRpc("jobs.list", {}, { user: await makeUser(), tx })).toEqual([]);
      expect(await callRpc("jobs.list", {}, { user: null })).toEqual([]);
    });
  });
});

describe("jobs.retryJob", () => {
  test("requeues a failed publish job and marks the video publishing (not scheduled)", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      // Convex put the video back to 'scheduled' with a past time, so the due-schedules sweep
      // could create a second publish job. 'publishing' keeps the sweep away.
      const v = await insertVideo(tx, user.id, { status: "failed", scheduledPublishAt: new Date(Date.now() - 60_000) });
      const [job] = await tx.insert(jobs).values({ userId: user.id, videoId: v.id, type: "publish", status: "failed", error: "quota", attempts: 3, completedAt: new Date() }).returning();

      await expect(callRpc("jobs.retryJob", { id: job.id }, { user: await makeUser(), tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await callRpc("jobs.retryJob", { id: job.id }, { user, tx });

      const [j] = await tx.select().from(jobs).where(eq(jobs.id, job.id));
      expect(j).toMatchObject({ status: "pending", error: null, attempts: 0, completedAt: null, startedAt: null });
      const [vid] = await tx.select().from(videos).where(eq(videos.id, v.id));
      expect(vid.status).toBe("publishing");

      // pressing it again while it is pending/processing is a harmless no-op
      await callRpc("jobs.retryJob", { id: job.id }, { user, tx });
      await tx.update(jobs).set({ status: "processing" }).where(eq(jobs.id, job.id));
      await callRpc("jobs.retryJob", { id: job.id }, { user, tx });
      expect((await tx.select().from(jobs).where(eq(jobs.id, job.id)))[0].status).toBe("processing");

      // completed jobs can't be retried
      await tx.update(jobs).set({ status: "completed" }).where(eq(jobs.id, job.id));
      await expect(callRpc("jobs.retryJob", { id: job.id }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  test("keeps the Convex guards: nothing to retry for a published video or a destroyed file", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const published = await insertVideo(tx, user.id, { status: "published", publishedVideoId: "yt123" });
      const destroyed = await insertVideo(tx, user.id, { status: "failed", cloudinaryDeletedAt: new Date() });
      const [a] = await tx.insert(jobs).values({ userId: user.id, videoId: published.id, type: "publish", status: "failed" }).returning();
      const [b] = await tx.insert(jobs).values({ userId: user.id, videoId: destroyed.id, type: "publish", status: "failed" }).returning();

      await expect(callRpc("jobs.retryJob", { id: a.id }, { user, tx })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "This video has already been published to YouTube — nothing to retry.",
      });
      await expect(callRpc("jobs.retryJob", { id: b.id }, { user, tx })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "The video file is no longer in storage. Re-upload the video to publish it again.",
      });
      // both stay failed and the published video is untouched
      expect((await tx.select().from(jobs).where(eq(jobs.id, a.id)))[0].status).toBe("failed");
      expect((await tx.select().from(videos).where(eq(videos.id, published.id)))[0].status).toBe("published");
    });
  });

  test("refuses with a conflict when another job of the same type is already active", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await insertVideo(tx, user.id, { status: "failed" });
      const [failed] = await tx.insert(jobs).values({ userId: user.id, videoId: v.id, type: "publish", status: "failed" }).returning();
      await tx.insert(jobs).values({ userId: user.id, videoId: v.id, type: "publish", status: "pending" });

      await expect(callRpc("jobs.retryJob", { id: failed.id }, { user, tx })).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await tx.select().from(jobs).where(eq(jobs.id, failed.id)))[0].status).toBe("failed");
      expect((await tx.select().from(videos).where(eq(videos.id, v.id)))[0].status).toBe("failed");
    });
  });

  test("a failed generation job is requeued without touching the video", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await insertVideo(tx, user.id, { status: "failed", sourceType: "generate", rawFileKey: "", rawFileSize: 0 });
      const [job] = await tx.insert(jobs).values({ userId: user.id, videoId: v.id, type: "generation", status: "failed", error: "veo down" }).returning();
      await callRpc("jobs.retryJob", { id: job.id }, { user, tx });
      expect((await tx.select().from(jobs).where(eq(jobs.id, job.id)))[0]).toMatchObject({ status: "pending", error: null });
      expect((await tx.select().from(videos).where(eq(videos.id, v.id)))[0].status).toBe("failed");
    });
  });
});
