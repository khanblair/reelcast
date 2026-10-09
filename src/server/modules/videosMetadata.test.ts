import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { videoMetadataVersions, videos } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { callRpc, inRolledBackTx } from "../testing";

const FILE = "https://res.cloudinary.com/demo/video/upload/v1/a.mp4";

async function mkVideo(tx: DbLike, userId: string, over: Partial<typeof videos.$inferInsert> = {}) {
  const [v] = await tx
    .insert(videos)
    .values({ userId, title: "Original title", rawFileKey: FILE, rawFileSize: 1, status: "ready", ...over })
    .returning();
  return v;
}

const row = async (tx: DbLike, id: string) => (await tx.select().from(videos).where(eq(videos.id, id)))[0];
const versions = (tx: DbLike, id: string) => tx.select().from(videoMetadataVersions).where(eq(videoMetadataVersions.videoId, id));

describe("videos.updateMetadata", () => {
  test("writes the fields publishing reads (ai_title ?? title) and keeps the replaced AI values in history", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { aiTitle: "AI title", aiDescription: "AI description", aiTags: ["ai", "tag"] });
      await callRpc("videos.updateMetadata", { id: v.id, title: "My own title", description: "Hand written", tags: ["one", "two"] }, { user, tx });

      const after = await row(tx, v.id);
      expect(after.aiTitle).toBe("My own title");
      expect(after.aiDescription).toBe("Hand written");
      expect(after.aiTags).toEqual(["one", "two"]);

      const history = await versions(tx, v.id);
      expect(history.length).toBe(1);
      expect(history[0]).toMatchObject({ aiTitle: "AI title", aiDescription: "AI description", aiTags: ["ai", "tag"] });

      const got = (await callRpc("videos.get", { id: v.id }, { user, tx })) as { aiTitle?: string; metadataHistory?: { aiTitle?: string }[] };
      expect(got.aiTitle).toBe("My own title");
      expect(got.metadataHistory?.[0]?.aiTitle).toBe("AI title");
    });
  });

  test("a first edit on a video without AI metadata uses the plain title/description as the base", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { description: "Plain description", tags: ["plain"] });
      await callRpc("videos.updateMetadata", { id: v.id, title: "New" }, { user, tx });
      const after = await row(tx, v.id);
      expect(after).toMatchObject({ aiTitle: "New", aiDescription: "Plain description", aiTags: ["plain"] });
      expect((await versions(tx, v.id)).length).toBe(0); // nothing AI-written was replaced
    });
  });

  test("only the fields you pass change", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { aiTitle: "T", aiDescription: "D", aiTags: ["x"] });
      await callRpc("videos.updateMetadata", { id: v.id, description: "D2" }, { user, tx });
      expect(await row(tx, v.id)).toMatchObject({ aiTitle: "T", aiDescription: "D2", aiTags: ["x"] });
    });
  });

  test("an edit that changes nothing adds no history entry", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { aiTitle: "T", aiDescription: "D", aiTags: ["x"] });
      await callRpc("videos.updateMetadata", { id: v.id, title: "T", description: "D", tags: ["x"] }, { user, tx });
      expect((await versions(tx, v.id)).length).toBe(0);
    });
  });

  test("history is capped at the last 10 versions", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { aiTitle: "start", aiDescription: "d", aiTags: [] });
      for (let i = 0; i < 12; i++) await callRpc("videos.updateMetadata", { id: v.id, title: `title ${i}` }, { user, tx });
      expect((await versions(tx, v.id)).length).toBe(10);
    });
  });

  test("tags are trimmed, de-duplicated (case-insensitive) and blanks dropped", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id);
      await callRpc("videos.updateMetadata", { id: v.id, tags: ["  alpha ", "ALPHA", "", "beta   gamma", "alpha"] }, { user, tx });
      expect((await row(tx, v.id)).aiTags).toEqual(["alpha", "beta gamma"]);
    });
  });
});

describe("videos.updateMetadata: access and state", () => {
  test("signed-out callers are rejected", async () => {
    await expect(callRpc("videos.updateMetadata", { id: crypto.randomUUID(), title: "x" }, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  test("another user's video is NOT_FOUND and stays untouched", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const v = await mkVideo(tx, user.id, { aiTitle: "mine" });
      await expect(callRpc("videos.updateMetadata", { id: v.id, title: "hijack" }, { user: other, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await row(tx, v.id)).aiTitle).toBe("mine");
    });
  });

  test("publishing and published videos cannot be edited", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      for (const status of ["publishing", "published"] as const) {
        const v = await mkVideo(tx, user.id, { status, aiTitle: "locked" });
        await expect(callRpc("videos.updateMetadata", { id: v.id, title: "nope" }, { user, tx })).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await row(tx, v.id)).aiTitle).toBe("locked");
      }
    });
  });

  test("draft, ready, scheduled and failed videos can be edited", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      for (const status of ["draft", "ready", "scheduled", "failed"] as const) {
        const v = await mkVideo(tx, user.id, { status });
        await callRpc("videos.updateMetadata", { id: v.id, title: `edited ${status}` }, { user, tx });
        expect((await row(tx, v.id)).aiTitle).toBe(`edited ${status}`);
      }
    });
  });
});

describe("videos.updateMetadata: YouTube limits", () => {
  const bad = async (args: Record<string, unknown>, message?: RegExp) => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { aiTitle: "keep" });
      const p = callRpc("videos.updateMetadata", { id: v.id, ...args }, { user, tx });
      await expect(p).rejects.toMatchObject({ code: "BAD_REQUEST" });
      if (message) await expect(callRpc("videos.updateMetadata", { id: v.id, ...args }, { user, tx })).rejects.toThrow(message);
      expect((await row(tx, v.id)).aiTitle).toBe("keep"); // nothing was written
    });
  };

  test("nothing to update", () => bad({}));
  test("empty or blank title", () => bad({ title: "   " }, /Title is required/));
  test("title over 100 characters", () => bad({ title: "x".repeat(101) }, /at most 100/));
  test("angle brackets in title or description", async () => {
    await bad({ title: "a <b> c" }, /can't contain/);
    await bad({ description: "hello > world" }, /can't contain/);
  });
  test("description over 5,000 bytes (counted in bytes, not characters)", () => bad({ description: "é".repeat(2_600) }, /5,000 bytes/));
  test("more than 50 tags", () => bad({ tags: Array.from({ length: 51 }, (_, i) => `t${i}`) }, /At most 50 tags/));
  test("a tag over 100 characters", () => bad({ tags: ["x".repeat(101)] }, /at most 100/));
  test("tags over YouTube's 500-character total (commas and quotes count)", () =>
    bad({ tags: Array.from({ length: 40 }, (_, i) => `tag-number-${String(i).padStart(2, "0")}`) }, /500 characters/));

  test("exactly at the limits is accepted", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id);
      await callRpc("videos.updateMetadata", { id: v.id, title: "x".repeat(100), description: "a".repeat(5_000) }, { user, tx });
      const after = await row(tx, v.id);
      expect(after.aiTitle?.length).toBe(100);
      expect(after.aiDescription?.length).toBe(5_000);
    });
  });
});
