import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs, videos, youtubeChannels } from "@/db/schema";
import { NonRetryableError } from "@/server/jobs/handlers";
import { inRolledBackTx } from "@/server/testing";
import { makeDeps, mkChannel, mkJob, mkVideo } from "./dbkit";
import { runPublishJob } from "./run";
import { CLOUD_URL, FakeWorld, KIB256 } from "./testkit";

setDefaultTimeout(120_000);

const opts = { chunkSize: KIB256, budgetMs: 1_000_000 };
const ctxOf = (tx: Parameters<Parameters<typeof inRolledBackTx>[0]>[0]["tx"]) => ({ db: tx, now: new Date() });

async function video(tx: Parameters<typeof mkVideo>[0], id: string) {
  const [v] = await tx.select().from(videos).where(eq(videos.id, id));
  return v;
}

describe("publish job: success path", () => {
  test("uploads, persists the YouTube id BEFORE any cleanup, then publishes + notifies once", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(2 * KIB256 + 10);
      const ch = await mkChannel(tx, user.id);
      const v = await mkVideo(tx, user.id, { youtubeChannelId: ch.channelId, rawFileKey: CLOUD_URL, aiTitle: "AI title", description: "d #Shorts" });
      const job = await mkJob(tx, user.id, v.id);

      // When Cloudinary cleanup runs, the id must already be in the database.
      let idAtCleanup: string | null | undefined = "not called";
      const { deps, spies } = makeDeps(world, {
        destroyCloudinaryAsset: async (publicId) => {
          const [row] = await tx.select({ id: videos.publishedVideoId }).from(videos).where(eq(videos.id, v.id));
          idAtCleanup = row.id;
          spies.destroyed.push(publicId);
        },
      });

      const out = await runPublishJob(job, ctxOf(tx), deps, opts);
      expect(out).toEqual({ metadata: { youtubeVideoId: "yt_video_1", bytes: 2 * KIB256 + 10 } });
      expect(idAtCleanup).toBe("yt_video_1");

      const after = await video(tx, v.id);
      expect(after.status).toBe("published");
      expect(after.publishedVideoId).toBe("yt_video_1");
      expect(after.publishedAt).toBeInstanceOf(Date);
      expect(after.cloudinaryDeletedAt).toBeInstanceOf(Date);
      expect(spies.destroyed).toEqual(["folder/clip"]);
      expect(spies.tokenCalls).toEqual([ch.id]); // the channel named on the video, by YouTube channel id
      expect(spies.quota).toEqual([[user.id, 1600]]); // one session = one videos.insert
      expect(spies.notifications.map((n) => n.type)).toEqual(["success"]);
      expect(spies.messages.map((m) => m.event)).toEqual(["publishSuccess"]);
      expect(spies.messages[0].data).toMatchObject({ title: "AI title", youtubeVideoId: "yt_video_1", url: "https://youtu.be/yt_video_1" });
      // the lease and session never survive completion in what the queue stores
      expect(JSON.stringify(out)).not.toContain("upload_id");
    });
  });

  test("falls back to the primary channel when the video names none", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.update(youtubeChannels).set({ isPrimary: false }).where(eq(youtubeChannels.userId, user.id));
      const primary = await mkChannel(tx, user.id, { isPrimary: true });
      const world = new FakeWorld(KIB256);
      const v = await mkVideo(tx, user.id);
      const { deps, spies } = makeDeps(world);
      await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts);
      expect(spies.tokenCalls).toEqual([primary.id]);
    });
  });

  test("a user with only a non-primary channel and a video naming none has NO channel to publish to", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.update(youtubeChannels).set({ isPrimary: false }).where(eq(youtubeChannels.userId, user.id));
      await mkChannel(tx, user.id, { isPrimary: false });
      const world = new FakeWorld(KIB256);
      const v = await mkVideo(tx, user.id);
      const { deps, spies } = makeDeps(world);
      const err = await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect(err.message).toContain("YouTube account is not connected");
      expect(spies.tokenCalls).toEqual([]);
      expect(world.fetchCalls).toBe(0);
    });
  });

  test("a video delivered as ready or scheduled (jobs.create, manual retry) is claimed into publishing and published", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await mkChannel(tx, user.id, { channelId: "UC_named" });
      for (const status of ["ready", "scheduled", "failed"] as const) {
        const world = new FakeWorld(KIB256);
        const v = await mkVideo(tx, user.id, { status, youtubeChannelId: "UC_named" });
        const { deps } = makeDeps(world);
        await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts);
        expect((await video(tx, v.id)).status).toBe("published");
      }
    });
  });
});

describe("publish job: idempotency", () => {
  test("a video that already has its YouTube id is finished, never uploaded again", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      await mkChannel(tx, user.id);
      const v = await mkVideo(tx, user.id, { status: "publishing", publishedVideoId: "already_there", publishedAt: new Date() });
      const job = await mkJob(tx, user.id, v.id);
      const { deps, spies } = makeDeps(world);

      const out = await runPublishJob(job, ctxOf(tx), deps, opts);
      expect(out).toEqual({ metadata: { youtubeVideoId: "already_there" } });
      expect(world.fetchCalls).toBe(0); // no HEAD, no session, no bytes
      expect(spies.tokenCalls).toEqual([]);
      expect(spies.quota).toEqual([]);
      const after = await video(tx, v.id);
      expect(after.status).toBe("published");
      expect(after.publishedVideoId).toBe("already_there"); // never replaced
      expect(spies.notifications).toHaveLength(1);

      // A further redelivery: still nothing uploaded, and no second notification.
      await runPublishJob(job, ctxOf(tx), deps, opts);
      expect(world.fetchCalls).toBe(0);
      expect(spies.notifications).toHaveLength(1);
    });
  });

  test("a run killed after Google finished but before the id was saved recovers the id from the saved session, no re-upload", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(4 * KIB256);
      world.costMs = 10_000;
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const job = await mkJob(tx, user.id, v.id);
      const { deps, spies } = makeDeps(world);

      const first = (await runPublishJob(job, ctxOf(tx), deps, { chunkSize: KIB256, budgetMs: 25_000 })) as { metadata: unknown };
      // The "killed" run finished the upload at Google but never wrote the id.
      world.sessions[0].received = 4 * KIB256;
      world.sessions[0].complete = true;
      const chunksBefore = world.chunkRanges.length;

      const out = await runPublishJob({ ...job, metadata: first.metadata }, ctxOf(tx), deps, opts);
      expect(out).toMatchObject({ metadata: { youtubeVideoId: "yt_video_1" } });
      expect(world.chunkRanges.length).toBe(chunksBefore); // not one more byte sent
      expect(world.initiated).toBe(1);
      expect(spies.quota).toHaveLength(1);
      expect((await video(tx, v.id)).publishedVideoId).toBe("yt_video_1");
    });
  });
});

describe("publish job: resumable across runs", () => {
  test("defers with the session saved (encrypted), then the next run resumes it: one session, every chunk sent once", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(6 * KIB256);
      world.costMs = 10_000;
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const job = await mkJob(tx, user.id, v.id);
      const { deps, spies } = makeDeps(world);

      const first = await runPublishJob(job, ctxOf(tx), deps, { chunkSize: KIB256, budgetMs: 50_000 });
      expect(first).toMatchObject({ deferMs: 2000 });
      const meta = (first as { metadata: { upload: Record<string, unknown>; progress: { percent: number } } }).metadata;
      expect(meta.upload.totalSize).toBe(6 * KIB256);
      expect(meta.progress.percent).toBeGreaterThan(0);
      expect(JSON.stringify(meta)).not.toContain("upload_id"); // the session URI is never stored in clear
      expect((await video(tx, v.id)).status).toBe("publishing");
      expect(spies.notifications).toEqual([]);

      // What the queue does on deferJob: store the returned metadata and run the job again.
      await tx.update(jobs).set({ metadata: meta, status: "processing" }).where(eq(jobs.id, job.id));
      world.costMs = 0;
      const second = await runPublishJob({ ...job, metadata: meta }, ctxOf(tx), deps, opts);
      expect(second).toMatchObject({ metadata: { youtubeVideoId: "yt_video_1" } });

      expect(world.initiated).toBe(1);
      expect(spies.quota).toEqual([[user.id, 1600]]);
      expect(world.chunkRanges).toHaveLength(6);
      expect(new Set(world.chunkRanges).size).toBe(6);
      expect((await video(tx, v.id)).status).toBe("published");
    });
  });

  test("progress is saved after every chunk, so a run killed mid-upload resumes the same session", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(4 * KIB256);
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const job = await mkJob(tx, user.id, v.id);
      const { deps } = makeDeps(world);

      // Kill the run (throw from "storage") while reading chunk 3, after chunks 0-1 went up.
      let reads = 0;
      const origFetch = world.fetch;
      const killing = { ...deps, fetch: ((i: string | URL | Request, init?: RequestInit) => {
        const isRange = new Headers(init?.headers as HeadersInit | undefined).has("range");
        if (isRange && ++reads === 3) return Promise.reject(new Error("process killed"));
        return origFetch(i, init);
      }) as typeof deps.fetch };
      await expect(runPublishJob(job, ctxOf(tx), killing, opts)).rejects.toThrow("process killed");
      expect(world.sessions[0].received).toBe(2 * KIB256);
      const [row] = await tx.select({ metadata: jobs.metadata }).from(jobs).where(eq(jobs.id, job.id));
      const saved = row.metadata as { upload: { offset: number; sessionUriEnc: string }; lease?: unknown };
      expect(saved.upload.offset).toBe(2 * KIB256);
      expect(saved.upload.sessionUriEnc.startsWith("v1:")).toBe(true);
      expect(saved.lease).toBeUndefined(); // released even though the run failed

      // The retry (attempt 2) continues the SAME session from Google's offset.
      const out = await runPublishJob({ ...job, attempts: 2, metadata: row.metadata }, ctxOf(tx), deps, opts);
      expect(out).toMatchObject({ metadata: { youtubeVideoId: "yt_video_1" } });
      expect(world.initiated).toBe(1);
      expect(world.chunkRanges).toHaveLength(4);
    });
  });

  test("an expired session is replaced by a fresh one that starts from byte 0", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(3 * KIB256);
      world.costMs = 10_000;
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const job = await mkJob(tx, user.id, v.id);
      const { deps, spies } = makeDeps(world);
      const first = (await runPublishJob(job, ctxOf(tx), deps, { chunkSize: KIB256, budgetMs: 25_000 })) as { metadata: unknown };

      world.sessions[0].alive = false; // Google forgot it
      world.costMs = 0;
      const out = await runPublishJob({ ...job, metadata: first.metadata }, ctxOf(tx), deps, opts);
      expect(out).toMatchObject({ metadata: { youtubeVideoId: "yt_video_1" } });
      expect(world.initiated).toBe(2);
      expect(world.sessions[1].received).toBe(3 * KIB256);
      expect(spies.quota).toHaveLength(2);
    });
  });

  test("a saved session for a different file is not reused", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const job = await mkJob(tx, user.id, v.id, {
        metadata: { upload: { v: 1, sourceUrl: "https://res.cloudinary.com/demo/video/upload/other.mp4", channelRowId: "x", totalSize: 1, chunkSize: KIB256, sessionUriEnc: "v1:a:b:c", offset: 0, stalls: 0, startedAt: "2026-01-01T00:00:00Z" } },
      });
      const { deps } = makeDeps(world);
      const out = await runPublishJob(job, ctxOf(tx), deps, opts);
      expect(out).toMatchObject({ metadata: { youtubeVideoId: "yt_video_1" } });
      expect(world.initiated).toBe(1);
    });
  });
});

describe("publish job: failure handling", () => {
  test("file gone from storage (404): permanent, video failed, user told once, storage flagged", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      world.storage.headStatus = 404;
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const { deps, spies } = makeDeps(world);

      const err = await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      const after = await video(tx, v.id);
      expect(after.status).toBe("failed");
      expect(after.storageMissing).toBe(true);
      expect(world.initiated).toBe(0);
      expect(spies.notifications.map((n) => n.type)).toEqual(["error"]);
      expect(spies.messages.map((m) => m.event)).toEqual(["publishFailure"]);
    });
  });

  test("a transient YouTube error on a non-final attempt: rethrown for retry, video stays publishing, nobody notified", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      world.initStatus = 503;
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const { deps, spies } = makeDeps(world);

      const err = await runPublishJob(await mkJob(tx, user.id, v.id, { attempts: 1 }), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NonRetryableError);
      expect((await video(tx, v.id)).status).toBe("publishing");
      expect(spies.notifications).toEqual([]);
      expect(spies.messages).toEqual([]);
    });
  });

  test("the same transient error on the LAST attempt fails the video and tells the user", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      world.initStatus = 503;
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const { deps, spies } = makeDeps(world);

      const err = await runPublishJob(await mkJob(tx, user.id, v.id, { attempts: 3, maxAttempts: 3 }), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).not.toBeInstanceOf(NonRetryableError); // the queue fails the job itself: attempts == max
      expect((await video(tx, v.id)).status).toBe("failed");
      expect(spies.notifications).toHaveLength(1);
      expect(spies.messages[0].data).toMatchObject({ attemptsLabel: "3 attempts" });
    });
  });

  test("a permanent YouTube rejection (400) is NonRetryable on the first attempt", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      world.initStatus = 400;
      world.initBody = JSON.stringify({ error: { code: 400, message: "Invalid title", errors: [{ reason: "invalidTitle" }] } });
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const { deps, spies } = makeDeps(world);
      const err = await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect((await video(tx, v.id)).status).toBe("failed");
      expect(spies.messages[0].data.error).toContain("Invalid title");
    });
  });

  test("daily quota exhausted is retryable (it can clear) but is explained to the user when attempts run out", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      world.initStatus = 403;
      world.initBody = JSON.stringify({ error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } });
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const { deps, spies } = makeDeps(world);
      const err = await runPublishJob(await mkJob(tx, user.id, v.id, { attempts: 3 }), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).not.toBeInstanceOf(NonRetryableError);
      expect(spies.messages[0].data.error).toContain("quota");
    });
  });

  test("revoked access (getValidAccessToken throws NonRetryableError) fails fast", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const { deps } = makeDeps(world, {
        getValidAccessToken: async () => {
          throw new NonRetryableError("YouTube access was revoked.");
        },
      });
      const err = await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect(world.fetchCalls).toBe(0);
      expect((await video(tx, v.id)).status).toBe("failed");
    });
  });

  test("no connected channel: permanent", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
      const v = await mkVideo(tx, user.id);
      const { deps } = makeDeps(world);
      const err = await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect(err.message).toContain("YouTube account is not connected");
    });
  });

  test("a file URL outside Cloudinary is refused before any request (SSRF)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c", rawFileKey: "http://169.254.169.254/latest/meta-data/" });
      const { deps } = makeDeps(world);
      const err = await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect(world.fetchCalls).toBe(0);
    });
  });

  test("files already deleted / flagged missing are refused up front", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      for (const over of [{ cloudinaryDeletedAt: new Date() }, { storageMissing: true }]) {
        const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c", ...over });
        const { deps } = makeDeps(world);
        await expect(runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts)).rejects.toBeInstanceOf(NonRetryableError);
      }
      expect(world.fetchCalls).toBe(0);
    });
  });

  test("a video that is not publishable (draft) or no longer exists completes quietly without any request", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(KIB256);
      const v = await mkVideo(tx, user.id, { status: "draft" });
      const { deps } = makeDeps(world);
      const out = await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts);
      expect(out).toMatchObject({ metadata: { skipped: "video is draft" } });
      expect((await video(tx, v.id)).status).toBe("draft");
      expect(world.fetchCalls).toBe(0);
    });
  });

  test("the run leaves the tick room: with little time left it defers without doing any work; with more it shortens its budget", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const job = await mkJob(tx, user.id, v.id);

      // 15s before the tick's claim deadline: less than the 10s reserve + 10s minimum -> next tick.
      const tight = new FakeWorld(KIB256);
      const t = makeDeps(tight, { now: () => 1_000_000 });
      expect(await runPublishJob(job, { ...ctxOf(tx), deadline: 1_000_000 + 15_000 }, t.deps, opts)).toEqual({ deferMs: 2000 });
      expect(tight.fetchCalls).toBe(0);

      // 30s before the deadline: runs, but only for the time that is left (20s): 3 chunks at 10s each is too many.
      const roomy = new FakeWorld(6 * KIB256);
      roomy.costMs = 10_000;
      const r = makeDeps(roomy);
      const out = await runPublishJob(job, { ...ctxOf(tx), deadline: roomy.now() + 30_000 }, r.deps, { chunkSize: KIB256, budgetMs: 1_000_000 });
      expect(out).toMatchObject({ deferMs: 2000 });
      expect(roomy.chunkRanges.length).toBeGreaterThan(0);
      expect(roomy.chunkRanges.length).toBeLessThan(6);
    });
  });
});

describe("publish job: token rejection and what survives a failure", () => {
  test("a 401 from YouTube is retryable and forces the next attempt to refresh the token", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const world = new FakeWorld(2 * KIB256);
      world.faults.set(0, { type: "status", status: 401 });
      const ch = await mkChannel(tx, user.id, { channelId: "UC_c" });
      const v = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const { deps } = makeDeps(world);
      const err = await runPublishJob(await mkJob(tx, user.id, v.id), ctxOf(tx), deps, opts).catch((e) => e);
      expect(err).toMatchObject({ name: "YouTubeApiError", status: 401 });
      expect(err).not.toBeInstanceOf(NonRetryableError);
      const [row] = await tx.select({ e: youtubeChannels.tokenExpiry }).from(youtubeChannels).where(eq(youtubeChannels.id, ch.id));
      expect(row.e.getTime()).toBeLessThan(Date.now());
    });
  });

  test("out of attempts on a TRANSIENT error keeps the upload session (Retry resumes it); a PERMANENT one drops it", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await mkChannel(tx, user.id, { channelId: "UC_c" });
      const sessionOf = async (jobId: string) =>
        ((await tx.select({ m: jobs.metadata }).from(jobs).where(eq(jobs.id, jobId)))[0].m as { upload?: unknown; lease?: unknown } | null) ?? {};

      const transient = new FakeWorld(2 * KIB256);
      for (let i = 0; i < 10; i++) transient.faults.set(i, { type: "status", status: 503 });
      const v1 = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const j1 = await mkJob(tx, user.id, v1.id, { attempts: 3, maxAttempts: 3 });
      await runPublishJob(j1, ctxOf(tx), makeDeps(transient).deps, opts).catch(() => undefined);
      const kept = await sessionOf(j1.id);
      expect(kept.upload).toBeDefined();
      expect(kept.lease).toBeUndefined();

      const permanent = new FakeWorld(2 * KIB256);
      permanent.faults.set(0, { type: "status", status: 400 });
      const v2 = await mkVideo(tx, user.id, { youtubeChannelId: "UC_c" });
      const j2 = await mkJob(tx, user.id, v2.id);
      await runPublishJob(j2, ctxOf(tx), makeDeps(permanent).deps, opts).catch(() => undefined);
      const dropped = await sessionOf(j2.id);
      expect(dropped.upload).toBeUndefined();
      expect(dropped.lease).toBeUndefined();
    });
  });
});
