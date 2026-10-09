import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { notifications, tasks, videoMetadataVersions, videos } from "@/db/schema";
import { NonRetryableError } from "@/server/jobs/handlers";
import { enqueueTask, type TaskRow } from "@/server/jobs/queue";
import { inRolledBackTx } from "@/server/testing";
import { META_JSON, geminiText, mkVideo, mockFetch, putSettings, setEnv, setPlatformKeys, setUsage, usageCount } from "./testkit";
import { metadataTaskKey } from "./metadataRuns";
import { runMetadataTask } from "./metadataTask";

setDefaultTimeout(120_000);

const CLOUD = "https://res.cloudinary.com/demo/video/upload/v1/clip.mp4";
let restoreEnv: () => void;
let net: ReturnType<typeof mockFetch>;
let geminiBehaviour: () => Response | Promise<Response>;

beforeEach(() => {
  restoreEnv = setEnv({ GEMINI_API_KEY: undefined });
  geminiBehaviour = () => geminiText(META_JSON);
  net = mockFetch((url) => {
    if (url.includes(":generateContent")) return geminiBehaviour();
    if (url.includes("res.cloudinary.com")) return new Response(new Uint8Array([0xff, 0xd8]), { status: 200 });
    return new Response("nope", { status: 404 });
  });
});
afterEach(() => {
  net.restore();
  restoreEnv();
});

const gemCalls = () => net.calls.filter((c) => c.url.includes(":generateContent")).length;
const video = async (tx: DbLike, id: string) => (await tx.select().from(videos).where(eq(videos.id, id)))[0];

async function scheduledVideo(tx: DbLike, userId: string, over: Partial<typeof videos.$inferInsert> = {}) {
  await setPlatformKeys(tx, { gemini: "gem-test-key" });
  await putSettings(tx, userId, {});
  return mkVideo(tx, userId, { rawFileKey: CLOUD, rawFileSize: 10, status: "draft", metadataScheduledAt: new Date(Date.now() - 1000), ...over });
}

async function taskFor(tx: DbLike, userId: string, videoId: string, payload: Record<string, unknown> = {}, over: Partial<TaskRow> = {}): Promise<TaskRow> {
  const { task } = await enqueueTask(tx, { kind: "metadata.generate", payload: { videoId, ...payload }, userId, dedupeKey: metadataTaskKey(videoId) });
  return { ...task, status: "running", attempts: 1, ...over };
}

describe("metadata.generate task (scheduled)", () => {
  test("generates once, marks ready, clears the schedule; a redelivery is a no-op", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await scheduledVideo(tx, user.id, { aiTitle: "Old", aiDescription: "Old d" });
      const used0 = await usageCount(tx, user.id, "metadata_generated");
      const task = await taskFor(tx, user.id, v.id);
      const ctx = { db: tx, now: new Date() };

      await runMetadataTask(task, ctx);
      const after = await video(tx, v.id);
      expect(after).toMatchObject({ status: "ready", aiTitle: "Generated Title", aiTags: ["a", "b"] });
      expect(after.metadataScheduledAt).toBeNull();
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0 + 1);
      expect(await tx.select().from(videoMetadataVersions).where(eq(videoMetadataVersions.videoId, v.id))).toHaveLength(1);
      const notes = await tx.select().from(notifications).where(eq(notifications.userId, user.id));
      expect(notes.some((n) => n.title === "Metadata ready" && n.type === "success")).toBe(true);
      expect(gemCalls()).toBe(1);

      // at-least-once redelivery: schedule already cleared -> nothing happens, nothing is charged
      await runMetadataTask(task, ctx);
      expect(gemCalls()).toBe(1);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0 + 1);
    });
  });

  test("skips deleted videos, cancelled schedules and videos that moved past draft", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ctx = { db: tx, now: new Date() };
      const base = await scheduledVideo(tx, user.id);
      const task = await taskFor(tx, user.id, base.id);

      // cancelled (schedule column cleared by a manual regeneration / cancel)
      await tx.update(videos).set({ metadataScheduledAt: null }).where(eq(videos.id, base.id));
      await runMetadataTask(task, ctx);
      // deleted
      await runMetadataTask({ ...task, payload: { videoId: "00000000-0000-4000-8000-0000000000aa" } }, ctx);
      // already processed since scheduling: schedule is cleared, status untouched
      await tx.update(videos).set({ metadataScheduledAt: new Date(), status: "scheduled" }).where(eq(videos.id, base.id));
      await runMetadataTask(task, ctx);
      const after = await video(tx, base.id);
      expect(after.status).toBe("scheduled");
      expect(after.metadataScheduledAt).toBeNull();
      expect(gemCalls()).toBe(0);
    });
  });

  test("plan limit: schedule cleared, user told, no Gemini call", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await scheduledVideo(tx, user.id);
      await tx.execute((await import("drizzle-orm")).sql`update users set plan = 'free' where id = ${user.id}`);
      await setUsage(tx, user.id, "metadata_generated", 5); // free limit
      await runMetadataTask(await taskFor(tx, user.id, v.id), { db: tx, now: new Date() });
      expect((await video(tx, v.id)).metadataScheduledAt).toBeNull();
      expect((await video(tx, v.id)).status).toBe("draft");
      expect(gemCalls()).toBe(0);
      const notes = await tx.select().from(notifications).where(eq(notifications.userId, user.id));
      expect(notes.some((n) => n.type === "error" && n.message.includes("limit reached"))).toBe(true);
    });
  });

  test("a manual regeneration that lands while Gemini is working wins (compare-and-swap), quota refunded", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await scheduledVideo(tx, user.id, { aiTitle: "Manual title" });
      const used0 = await usageCount(tx, user.id, "metadata_generated");
      geminiBehaviour = async () => {
        // the user regenerates manually meanwhile: that clears the schedule
        await tx.update(videos).set({ metadataScheduledAt: null }).where(eq(videos.id, v.id));
        return geminiText(META_JSON);
      };
      await runMetadataTask(await taskFor(tx, user.id, v.id), { db: tx, now: new Date() });
      const after = await video(tx, v.id);
      expect(after.aiTitle).toBe("Manual title"); // not overwritten
      expect(after.status).toBe("draft");
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0);
    });
  });

  test("transient failure refunds and retries; the last attempt clears the schedule and notifies", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await scheduledVideo(tx, user.id);
      const used0 = await usageCount(tx, user.id, "metadata_generated");
      geminiBehaviour = () => new Response("upstream down", { status: 503 });
      const ctx = { db: tx, now: new Date() };

      const task = await taskFor(tx, user.id, v.id);
      const e1 = await runMetadataTask({ ...task, attempts: 1 }, ctx).catch((e: unknown) => e);
      expect(e1).toBeInstanceOf(Error);
      expect(e1).not.toBeInstanceOf(NonRetryableError);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0); // refunded
      expect((await video(tx, v.id)).metadataScheduledAt).not.toBeNull(); // still scheduled for the retry

      const e2 = await runMetadataTask({ ...task, attempts: task.maxAttempts }, ctx).catch((e: unknown) => e);
      expect(e2).toBeInstanceOf(Error);
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0);
      const after = await video(tx, v.id);
      expect(after.metadataScheduledAt).toBeNull();
      expect(after.status).toBe("draft"); // "Video remains as draft"
      const notes = await tx.select().from(notifications).where(eq(notifications.userId, user.id));
      expect(notes.some((n) => n.title === "Metadata generation failed")).toBe(true);
    });
  });

  test("no Gemini key configured: finishes quietly (nothing a retry could fix) and refunds", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await scheduledVideo(tx, user.id);
      await setPlatformKeys(tx, { gemini: null });
      const used0 = await usageCount(tx, user.id, "metadata_generated");
      await runMetadataTask(await taskFor(tx, user.id, v.id), { db: tx, now: new Date() });
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0);
      expect((await video(tx, v.id)).metadataScheduledAt).toBeNull();
    });
  });

  test("manual mode keeps the rpc's unit across retries, leaves the status alone and cancels nothing it shouldn't", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await scheduledVideo(tx, user.id, { status: "ready", metadataScheduledAt: null });
      const used0 = await usageCount(tx, user.id, "metadata_generated");
      const task = await taskFor(tx, user.id, v.id, { mode: "manual", quotaConsumed: true });
      await runMetadataTask(task, { db: tx, now: new Date() });
      const after = await video(tx, v.id);
      expect(after).toMatchObject({ status: "ready", aiTitle: "Generated Title" });
      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0); // the task did not charge again
    });
  });

  test("invalid payload is a permanent failure", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const base = await taskFor(tx, user.id, "00000000-0000-4000-8000-0000000000aa");
      const err = await runMetadataTask({ ...base, payload: { videoId: "nope" } }, { db: tx, now: new Date() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NonRetryableError);
      void tasks;
    });
  });
});
