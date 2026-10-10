/**
 * generateForUpload, slow path: when frames are unavailable the call meters one unit and hands the work to the
 * `metadata.generate` task. A failed hand-over must not keep the unit, and must not lose the scheduled run it
 * was about to supersede. Gemini and Cloudinary are mocked (no network); the database work is real and rolled
 * back, on a synthetic user. The failing enqueue is injected by wrapping the handle (src/server/testing-faults.ts).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { tasks } from "@/db/schema";
import { META_JSON, geminiText, mkVideo, mockFetch, putSettings, setEnv, setPlatformKeys, usageCount } from "@/server/lib/generation/testkit";
import { callRpc, inRolledBackTx } from "@/server/testing";
import { failOn } from "@/server/testing-faults";

setDefaultTimeout(120_000);

const CLOUD = "https://res.cloudinary.com/demo/video/upload/v1/clip.mp4";
let restoreEnv: () => void;
let net: ReturnType<typeof mockFetch>;

beforeEach(() => {
  restoreEnv = setEnv({ GEMINI_API_KEY: undefined });
  // Cloudinary has no frames for the clip, so the inline attempt falls through to the slow path.
  net = mockFetch((url) => (url.includes("res.cloudinary.com") ? new Response("", { status: 404 }) : geminiText(META_JSON)));
});
afterEach(() => {
  net.restore();
  restoreEnv();
});

async function scheduledVideo(tx: Parameters<typeof mkVideo>[0], userId: string) {
  await setPlatformKeys(tx, { gemini: "gem-key" });
  await putSettings(tx, userId, {});
  const v = await mkVideo(tx, userId, { rawFileKey: CLOUD, status: "draft", aiTitle: "Current", metadataScheduledAt: new Date(Date.now() + 3_600_000) });
  // the scheduled auto-metadata run that a manual regeneration supersedes
  await tx.insert(tasks).values({ kind: "metadata.generate", payload: { videoId: v.id }, dedupeKey: `metadata:${v.id}`, userId, runAt: new Date(Date.now() + 3_600_000) });
  return v;
}

describe("actions.metadata.generateForUpload: slow-path hand-over", () => {
  test("a failing enqueue refunds the metered unit, keeps the scheduled run, and reports a clear error", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await scheduledVideo(tx, user.id);
      const used0 = await usageCount(tx, user.id, "metadata_generated");

      const err = await callRpc("actions.metadata.generateForUpload", { videoId: v.id }, { user, tx: failOn(tx, "insert", tasks) }).catch((e: unknown) => e);

      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0); // the unit went back
      const rows = await tx.select().from(tasks).where(eq(tasks.dedupeKey, `metadata:${v.id}`));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending"); // the cancel was undone with the failed enqueue: the scheduled run still happens
      expect(err).toMatchObject({ code: "INTERNAL", message: expect.stringContaining("Metadata generation failed") });
      expect(net.calls.every((c) => c.url.includes("res.cloudinary.com"))).toBe(true); // only the mocked frame lookup was attempted
    });
  });

  test("a healthy hand-over still keeps the unit with the task and supersedes the scheduled run", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await scheduledVideo(tx, user.id);
      const used0 = await usageCount(tx, user.id, "metadata_generated");

      const out = await callRpc("actions.metadata.generateForUpload", { videoId: v.id, humanize: true }, { user, tx });
      expect(out).toMatchObject({ title: "Current", queued: true });

      expect(await usageCount(tx, user.id, "metadata_generated")).toBe(used0 + 1); // the unit travels with the task
      const rows = await tx.select().from(tasks).where(eq(tasks.dedupeKey, `metadata:${v.id}`));
      expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "pending"]);
      expect(rows.find((r) => r.status === "pending")?.payload).toMatchObject({ videoId: v.id, mode: "manual", quotaConsumed: true, humanize: true });
    });
  });
});
