import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { generations, notifications, videoMetadataVersions, videos } from "@/db/schema";
// Import the handler registry first: generationJob.ts <-> handlers.ts is a cycle that only
// resolves cleanly when handlers.ts is the entry point.
import { NonRetryableError } from "@/server/jobs/handlers";
import type { VeoGenerationParams, VeoOperationResult } from "@/server/lib/ai";
import { VeoOperationError } from "@/server/lib/ai";
import { inRolledBackTx } from "@/server/testing";
import { MAX_POLLS, POLL_DEFER_MS, runGenerationJob, type GenerationDeps } from "./generationJob";
import { META_JSON, geminiText, mkJob, mkVideo, mockFetch, putSettings, setEnv, setPlan, setPlatformKeys, usageCount } from "./testkit";

setDefaultTimeout(120_000);

const OP = "models/veo-3.0-generate-001/operations/op1";
const CLOUD_URL = "https://res.cloudinary.com/demo/video/upload/v1/generated/x.mp4";

let restoreEnv: () => void;
let net: ReturnType<typeof mockFetch>;

beforeEach(() => {
  restoreEnv = setEnv({ GEMINI_API_KEY: undefined });
  net = mockFetch((url) => {
    if (url.includes(":generateContent")) return geminiText(META_JSON);
    if (url.includes("res.cloudinary.com")) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
    return new Response("not mocked", { status: 404 });
  });
});
afterEach(() => {
  net.restore();
  restoreEnv();
});

function fakeDeps(over: Partial<GenerationDeps> = {}) {
  const rec = {
    submitted: [] as VeoGenerationParams[],
    keys: [] as (string | null)[],
    polled: 0,
    downloads: [] as string[],
    uploads: [] as string[],
    byteUploads: 0,
    polls: [] as VeoOperationResult[],
  };
  const deps: GenerationDeps = {
    submitVeo: async (p, key) => {
      rec.submitted.push(p);
      rec.keys.push(key);
      return { operationName: OP };
    },
    pollVeo: async () => {
      rec.polled++;
      const next = rec.polls.shift();
      if (!next) throw new Error("test: no poll result queued");
      return next;
    },
    downloadVeo: async (uri) => {
      rec.downloads.push(uri);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } });
    },
    uploadStream: async (res, publicId) => {
      await res.arrayBuffer();
      rec.uploads.push(publicId);
      return { secureUrl: CLOUD_URL, bytes: 3, publicId };
    },
    uploadBytes: async (bytes, publicId) => {
      rec.byteUploads += bytes.byteLength;
      return { secureUrl: CLOUD_URL, bytes: bytes.byteLength, publicId };
    },
    now: () => Date.now(),
    ...over,
  };
  return { deps, rec };
}

async function setup(tx: DbLike, userId: string, plan: "free" | "pro" | "elite" = "pro") {
  await setPlan(tx, userId, plan);
  await setPlatformKeys(tx, { gemini: "gem-test-key" });
  await putSettings(tx, userId, {});
  return mkVideo(tx, userId, { sourceType: "generate", aiConfig: { prompt: "a cat surfing a wave", model: "veo-3" } });
}

const videoRow = async (tx: DbLike, id: string) => (await tx.select().from(videos).where(eq(videos.id, id)))[0];
const latestGen = async (tx: DbLike, videoId: string) =>
  (await tx.select().from(generations).where(eq(generations.videoId, videoId)).orderBy(desc(generations.createdAt)).limit(1))[0];

describe("generation job: Veo state machine", () => {
  test("submit -> poll pending -> poll done -> ready (resumable, idempotent)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const video = await setup(tx, user.id);
      const veo0 = await usageCount(tx, user.id, "veo_generated");
      const meta0 = await usageCount(tx, user.id, "metadata_generated");
      const { deps, rec } = fakeDeps();
      const ctx = { db: tx, now: new Date() };
      const job = mkJob(user.id, video.id);

      // 1. submit
      const r1 = await runGenerationJob(job, ctx, deps);
      expect(r1).toEqual({ deferMs: POLL_DEFER_MS, metadata: { step: "poll", polls: 0, operationName: OP } });
      expect(rec.submitted).toHaveLength(1);
      expect(rec.submitted[0]).toMatchObject({ model: "veo-3", prompt: "a cat surfing a wave", resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, generateAudio: true });
      expect(rec.keys[0]).toBe("gem-test-key"); // platform key resolved server-side
      expect(await usageCount(tx, user.id, "veo_generated")).toBe(veo0 + 1);
      let v = await videoRow(tx, video.id);
      expect(v).toMatchObject({ status: "generating", veoOperationName: OP, veoOperationDone: false });
      let g = await latestGen(tx, video.id);
      expect(g).toMatchObject({ status: "submitted", veoOperationName: OP, prompt: "a cat surfing a wave", model: "veo-3" });

      // 2. poll: still running -> defer, generation moves to processing, no second submit
      rec.polls.push({ operationName: OP, done: false });
      const r2 = await runGenerationJob({ ...job, metadata: r1 && "metadata" in r1 ? r1.metadata : null }, ctx, deps);
      expect(r2).toEqual({ deferMs: POLL_DEFER_MS, metadata: { step: "poll", polls: 1, operationName: OP } });
      expect((await latestGen(tx, video.id)).status).toBe("processing");
      expect(rec.submitted).toHaveLength(1);

      // 3. poll: done -> download, copy to Cloudinary, ready, metadata from the prompt, notification
      rec.polls.push({ operationName: OP, done: true, videoUri: "https://generativelanguage.googleapis.com/v1beta/files/abc", videoMimeType: "video/mp4" });
      const r3 = await runGenerationJob({ ...job, metadata: { step: "poll", polls: 1, operationName: OP } }, ctx, deps);
      expect(r3).toMatchObject({ metadata: { step: "done", bytes: 3 } });
      expect(rec.downloads).toEqual(["https://generativelanguage.googleapis.com/v1beta/files/abc"]);
      expect(rec.uploads).toEqual([`generated/${video.id}_${g.id}`]);
      v = await videoRow(tx, video.id);
      expect(v).toMatchObject({
        status: "ready",
        rawFileKey: CLOUD_URL,
        processedFileKey: CLOUD_URL,
        rawFileSize: 3,
        veoOperationDone: true,
        aiTitle: "Generated Title",
        aiTags: ["a", "b"],
      });
      expect(v.thumbnailUrl).toContain("so_1");
      expect(v.thumbnailUrl?.endsWith(".jpg")).toBe(true);
      g = await latestGen(tx, video.id);
      expect(g).toMatchObject({ status: "completed", outputVideoUrl: CLOUD_URL });
      expect(g.generationTimeMs).toBeGreaterThanOrEqual(0);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(meta0 + 1);
      const notes = await tx.select().from(notifications).where(eq(notifications.userId, user.id));
      expect(notes.some((n) => n.title === "Video generated" && n.type === "success" && n.link === `/video/${video.id}`)).toBe(true);

      // 4. at-least-once redelivery after completion: nothing happens
      const r4 = await runGenerationJob(job, ctx, deps);
      expect(r4).toBeUndefined();
      expect(rec.submitted).toHaveLength(1);
      expect(rec.polled).toBe(2);
      expect(rec.uploads).toHaveLength(1);
    });
  });

  test("resumes the existing operation after lost metadata; a newer run starts a fresh one", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const video = await setup(tx, user.id);
      const { deps, rec } = fakeDeps();
      const ctx = { db: tx, now: new Date() };
      const job = mkJob(user.id, video.id);
      await runGenerationJob(job, ctx, deps);
      expect(rec.submitted).toHaveLength(1);

      // worker crashed after persisting, metadata (poll counter) lost: must poll, not resubmit
      rec.polls.push({ operationName: OP, done: false });
      const again = await runGenerationJob({ ...job, metadata: null }, ctx, deps);
      expect(again).toMatchObject({ deferMs: POLL_DEFER_MS, metadata: { polls: 1 } });
      expect(rec.submitted).toHaveLength(1);

      // user pressed Retry / regenerate: a job that started after the old generation row
      const newer = mkJob(user.id, video.id, { startedAt: new Date(Date.now() + 120_000) });
      await runGenerationJob(newer, ctx, deps);
      expect(rec.submitted).toHaveLength(2);
    });
  });

  test("submit failures refund the quota unit; permanent ones fail the video, retryable ones do not (until the last attempt)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const video = await setup(tx, user.id);
      const veo0 = await usageCount(tx, user.id, "veo_generated");
      const ctx = { db: tx, now: new Date() };

      // retryable (503): plain Error so the queue backs off; unit refunded; video untouched
      const flaky = fakeDeps({ submitVeo: async () => { throw Object.assign(new Error("503 unavailable"), { status: 503 }); } });
      const err1 = await runGenerationJob(mkJob(user.id, video.id), ctx, flaky.deps).catch((e: unknown) => e);
      expect(err1).toBeInstanceOf(Error);
      expect(err1).not.toBeInstanceOf(NonRetryableError);
      expect(await usageCount(tx, user.id, "veo_generated")).toBe(veo0);
      expect((await videoRow(tx, video.id)).status).toBe("draft");

      // same error on the LAST attempt: gives up -> video failed + user told
      const err2 = await runGenerationJob(mkJob(user.id, video.id, { attempts: 3 }), ctx, flaky.deps).catch((e: unknown) => e);
      expect(err2).toBeInstanceOf(Error);
      expect((await videoRow(tx, video.id)).status).toBe("failed");
      expect(await usageCount(tx, user.id, "veo_generated")).toBe(veo0);
      expect((await tx.select().from(notifications).where(eq(notifications.userId, user.id))).some((n) => n.type === "error")).toBe(true);

      // permanent (400): NonRetryable, refunded
      await tx.update(videos).set({ status: "draft" }).where(eq(videos.id, video.id));
      const bad = fakeDeps({ submitVeo: async () => { throw Object.assign(new Error("prompt rejected"), { status: 400 }); } });
      const err3 = await runGenerationJob(mkJob(user.id, video.id), ctx, bad.deps).catch((e: unknown) => e);
      expect(err3).toBeInstanceOf(NonRetryableError);
      expect((err3 as Error).message).toContain("prompt rejected");
      expect(await usageCount(tx, user.id, "veo_generated")).toBe(veo0);
      expect((await videoRow(tx, video.id)).status).toBe("failed");
      expect(await tx.select().from(generations).where(eq(generations.videoId, video.id))).toHaveLength(0); // never submitted
    });
  });

  test("plan gate: free users never reach the Veo API", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const video = await setup(tx, user.id, "free");
      const { deps, rec } = fakeDeps();
      const err = await runGenerationJob(mkJob(user.id, video.id), { db: tx, now: new Date() }, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect((err as Error).message).toContain("limit reached");
      expect(rec.submitted).toHaveLength(0);
      expect((await videoRow(tx, video.id)).status).toBe("failed");
    });
  });

  test("polling is capped (poll count and wall clock) and fails the run for good", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const video = await setup(tx, user.id);
      const { deps, rec } = fakeDeps();
      const ctx = { db: tx, now: new Date() };
      const job = mkJob(user.id, video.id);
      await runGenerationJob(job, ctx, deps);

      // poll #MAX_POLLS and still not done
      rec.polls.push({ operationName: OP, done: false });
      const err = await runGenerationJob({ ...job, metadata: { polls: MAX_POLLS - 1 } }, ctx, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect((err as Error).message).toContain("timed out");
      let v = await videoRow(tx, video.id);
      expect(v.status).toBe("failed");
      expect(v.veoOperationName).toBeNull(); // cleared so a retry resubmits
      expect(await latestGen(tx, video.id)).toMatchObject({ status: "failed" });
      expect((await latestGen(tx, video.id)).error).toContain("timed out");

      // wall clock: a slow tick must not stretch 40 polls into an hour
      const video2 = await mkVideo(tx, user.id, { sourceType: "generate", aiConfig: { prompt: "p" } });
      const job2 = mkJob(user.id, video2.id);
      await runGenerationJob(job2, ctx, deps);
      const gen2 = await latestGen(tx, video2.id);
      rec.polls.push({ operationName: OP, done: false });
      const slow = { ...deps, now: () => gen2.createdAt.getTime() + 11 * 60_000 };
      const err2 = await runGenerationJob({ ...job2, metadata: { polls: 1 } }, ctx, slow).catch((e: unknown) => e);
      expect(err2).toBeInstanceOf(NonRetryableError);
      expect((await videoRow(tx, video2.id)).status).toBe("failed");
      v = await videoRow(tx, video.id);
      expect(v.status).toBe("failed");
    });
  });

  test("operation errors are permanent; download errors are retried and only fail on the last attempt", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const video = await setup(tx, user.id);
      const { deps, rec } = fakeDeps();
      const ctx = { db: tx, now: new Date() };
      const job = mkJob(user.id, video.id);
      await runGenerationJob(job, ctx, deps);

      // transient download failure: error propagates (queue retries), run stays alive
      rec.polls.push({ operationName: OP, done: true, videoUri: "https://generativelanguage.googleapis.com/v1beta/files/abc" });
      const flaky = { ...deps, downloadVeo: async () => { throw new Error("download 503"); } };
      const e1 = await runGenerationJob({ ...job, attempts: 1 }, ctx, flaky).catch((e: unknown) => e);
      expect(e1).not.toBeInstanceOf(NonRetryableError);
      expect((await videoRow(tx, video.id)).status).toBe("generating");
      expect((await latestGen(tx, video.id)).status).toBe("submitted");

      // Google says the operation itself failed (e.g. safety filter): never retried
      const failing = { ...deps, pollVeo: async () => { throw new VeoOperationError("Veo generation failed: blocked by safety filters"); } };
      const e2 = await runGenerationJob({ ...job, attempts: 1 }, ctx, failing).catch((e: unknown) => e);
      expect(e2).toBeInstanceOf(NonRetryableError);
      expect((e2 as Error).message).toContain("safety");
      expect((await videoRow(tx, video.id)).status).toBe("failed");
    });
  });

  test("Vertex-style inline bytes go through the bytes uploader (no URI download)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const video = await setup(tx, user.id);
      const { deps, rec } = fakeDeps();
      const ctx = { db: tx, now: new Date() };
      const job = mkJob(user.id, video.id);
      await runGenerationJob(job, ctx, deps);
      rec.polls.push({ operationName: OP, done: true, videoBytesBase64: Buffer.from([9, 9, 9, 9]).toString("base64") });
      await runGenerationJob(job, ctx, deps);
      expect(rec.downloads).toHaveLength(0);
      expect(rec.byteUploads).toBe(4);
      expect(await videoRow(tx, video.id)).toMatchObject({ status: "ready", rawFileSize: 4 });
    });
  });
});

describe("generation job: uploaded video analysis", () => {
  test("generates metadata from frames, keeps the previous version, marks ready", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: "gem-test-key" });
      await putSettings(tx, user.id, {});
      const video = await mkVideo(tx, user.id, {
        sourceType: "upload",
        status: "queued",
        rawFileKey: "https://res.cloudinary.com/demo/video/upload/v1/clip.mp4",
        rawFileSize: 10,
        aiTitle: "Old title",
        aiDescription: "Old description",
      });
      const { deps } = fakeDeps();
      const out = await runGenerationJob(mkJob(user.id, video.id), { db: tx, now: new Date() }, deps);
      expect(out).toEqual({ metadata: { step: "done" } });
      const v = await videoRow(tx, video.id);
      expect(v).toMatchObject({ status: "ready", aiTitle: "Generated Title", aiDescription: "Generated description.", aiTags: ["a", "b"] });
      const versions = await tx.select().from(videoMetadataVersions).where(eq(videoMetadataVersions.videoId, video.id));
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ aiTitle: "Old title", aiDescription: "Old description" });
      // frames, not the whole file, were fetched from Cloudinary (3 frames + 1 Gemini call)
      expect(net.calls.filter((c) => c.url.includes("res.cloudinary.com") && c.url.includes("so_"))).toHaveLength(3);
      expect(net.calls.filter((c) => c.url.includes(":generateContent"))).toHaveLength(1);
    });
  });

  test("no Gemini key anywhere: permanent failure on the first attempt, video marked failed", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: null });
      await putSettings(tx, user.id, {});
      const video = await mkVideo(tx, user.id, {
        sourceType: "upload",
        rawFileKey: "https://res.cloudinary.com/demo/video/upload/v1/clip.mp4",
        rawFileSize: 10,
      });
      const err = await runGenerationJob(mkJob(user.id, video.id), { db: tx, now: new Date() }, fakeDeps().deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect((err as Error).message).toContain("Gemini API key not configured");
      expect((await videoRow(tx, video.id)).status).toBe("failed");
    });
  });

  test("hosts other than Cloudinary are never fetched (SSRF)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlatformKeys(tx, { gemini: "gem-test-key" });
      await putSettings(tx, user.id, {});
      const video = await mkVideo(tx, user.id, { sourceType: "upload", rawFileKey: "http://169.254.169.254/latest/meta-data", rawFileSize: 10 });
      const err = await runGenerationJob(mkJob(user.id, video.id), { db: tx, now: new Date() }, fakeDeps().deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      expect((err as Error).message).toContain("Unsupported video location");
      expect(net.calls.some((c) => c.url.includes("169.254"))).toBe(false);
    });
  });
});
