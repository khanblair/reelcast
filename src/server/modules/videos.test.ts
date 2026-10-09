import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { tasks, usageLedger, users, videoMetadataVersions, videos } from "@/db/schema";
import { insertVideo } from "@/server/lib/content/testing";
import { monthKey } from "@/server/lib/usage";
import { callRpc, inRolledBackTx } from "@/server/testing";

setDefaultTimeout(120_000);

// must be on OUR cloud when NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME is set
const CLOUD = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || "demo";
const CLOUDINARY = `https://res.cloudinary.com/${CLOUD}/video/upload/v1/clip.mp4`;
type W = Record<string, unknown>;

describe("videos: ownership", () => {
  test("another user can neither read nor change my videos", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const mine = await insertVideo(tx, user.id, { title: "mine", captionsVtt: "WEBVTT" });
      const stranger = await makeUser();
      const strangerVideo = await insertVideo(tx, stranger.id, { title: "theirs" });

      // reads: nothing leaks, nothing throws (the detail page renders "not found" for null)
      expect(await callRpc("videos.get", { id: mine.id }, { user: stranger, tx })).toBeNull();
      expect(await callRpc("videos.get", { id: strangerVideo.id }, { user, tx })).toBeNull();
      const theirs = (await callRpc("videos.list", {}, { user: stranger, tx })) as W[];
      expect(theirs.map((v) => v._id)).toEqual([strangerVideo.id]);
      expect(await callRpc("videos.listScheduled", {}, { user: stranger, tx })).toEqual([]);
      expect(await callRpc("videos.get", { id: "not-a-uuid" }, { user, tx })).toBeNull();

      // writes: NOT_FOUND (never FORBIDDEN, which would confirm the id exists)
      const attempts: [string, W][] = [
        ["videos.updateStatus", { id: mine.id, status: "ready" }],
        ["videos.updatePrivacyStatus", { id: mine.id, privacyStatus: "public" }],
        ["videos.updatePublishAs", { id: mine.id, publishAs: "video" }],
        ["videos.updateAiConfig", { id: mine.id, aiConfig: { prompt: "x" } }],
        ["videos.schedulePublish", { id: mine.id, scheduledAt: Date.now() + 60_000 }],
        ["videos.cancelSchedule", { id: mine.id }],
        ["videos.scheduleMetadataForVideo", { id: mine.id, scheduledAt: Date.now() + 60_000 }],
      ];
      // independent calls on one connection are pipelined: one round trip instead of seven
      await Promise.all(attempts.map(([path, args]) => expect(callRpc(path, args, { user: stranger, tx })).rejects.toMatchObject({ code: "NOT_FOUND" })));
      const [still] = await tx.select().from(videos).where(eq(videos.id, mine.id));
      expect(still.status).toBe("draft");
      expect(still.privacyStatus).toBeNull();

      // the owner sees it; list omits the (large) caption transcript, get returns it
      const own = (await callRpc("videos.get", { id: mine.id }, { user, tx })) as W;
      expect(own._id).toBe(mine.id);
      expect(own.captionsVtt).toBe("WEBVTT");
      expect(own.metadataHistory).toEqual([]);
      const listed = (await callRpc("videos.list", {}, { user, tx })) as W[];
      expect(listed.map((v) => v._id)).toEqual([mine.id]); // never the stranger's
      expect("captionsVtt" in listed[0]).toBe(false);
    });
  });

  test("signed out: lists are empty, get requires a session", async () => {
    expect(await callRpc("videos.list", {}, { user: null })).toEqual([]);
    expect(await callRpc("videos.listScheduled", {}, { user: null })).toEqual([]);
    await expect(callRpc("videos.get", { id: crypto.randomUUID() }, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  test("list is newest first", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const a = await insertVideo(tx, user.id, { title: "a", createdAt: new Date("2026-01-01T00:00:00Z") });
      const b = await insertVideo(tx, user.id, { title: "b", createdAt: new Date("2026-02-01T00:00:00Z") });
      const ids = ((await callRpc("videos.list", {}, { user, tx })) as W[]).map((v) => v._id);
      expect(ids).toEqual([b.id, a.id]);
    });
  });
});

describe("videos: status transitions", () => {
  test("schedulePublish / cancelSchedule are compare-and-swap on status", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const draft = await insertVideo(tx, user.id);
      await expect(callRpc("videos.schedulePublish", { id: draft.id, scheduledAt: Date.now() + 60_000 }, { user, tx })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Only ready videos can be scheduled for publishing",
      });

      const v = await insertVideo(tx, user.id, { status: "ready" });
      const at = Date.now() + 3_600_000;
      await callRpc("videos.schedulePublish", { id: v.id, scheduledAt: at, privacyStatus: "unlisted" }, { user, tx });
      let [row] = await tx.select().from(videos).where(eq(videos.id, v.id));
      expect(row.status).toBe("scheduled");
      expect(row.scheduledPublishAt?.getTime()).toBe(at);
      expect(row.privacyStatus).toBe("unlisted");

      // already scheduled: a second schedule is refused
      await expect(callRpc("videos.schedulePublish", { id: v.id, scheduledAt: at + 1000 }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // it shows up in listScheduled (also after it stops being 'scheduled')
      const scheduled = (await callRpc("videos.listScheduled", {}, { user, tx })) as W[];
      expect(scheduled.find((s) => s._id === v.id)?.scheduledPublishAt).toBe(at);

      await callRpc("videos.cancelSchedule", { id: v.id }, { user, tx });
      [row] = await tx.select().from(videos).where(eq(videos.id, v.id));
      expect(row.status).toBe("ready");
      expect(row.scheduledPublishAt).toBeNull();
      // double click: still fine
      await callRpc("videos.cancelSchedule", { id: v.id }, { user, tx });

      // the sweep already took it: cancelling must not drag it back to ready
      const publishing = await insertVideo(tx, user.id, { status: "publishing", scheduledPublishAt: new Date(Date.now() - 1000) });
      await expect(callRpc("videos.cancelSchedule", { id: publishing.id }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const [p] = await tx.select().from(videos).where(eq(videos.id, publishing.id));
      expect(p.status).toBe("publishing");

      // bad times
      const r = await insertVideo(tx, user.id, { status: "ready" });
      await Promise.all(
        [-5, 0, Date.now() + 50 * 365 * 24 * 3_600_000].map((bad) =>
          expect(callRpc("videos.schedulePublish", { id: r.id, scheduledAt: bad }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" }),
        ),
      );
    });
  });

  test("updateStatus only allows the transitions the UI uses", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const gen = await insertVideo(tx, user.id, { rawFileKey: "", rawFileSize: 0, sourceType: "generate" });
      await callRpc("videos.updateStatus", { id: gen.id, status: "queued" }, { user, tx });
      expect((await tx.select().from(videos).where(eq(videos.id, gen.id)))[0].status).toBe("queued");

      // a queued generation is not ready, and a video without a file never becomes ready
      await expect(callRpc("videos.updateStatus", { id: gen.id, status: "ready" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await tx.update(videos).set({ status: "draft" }).where(eq(videos.id, gen.id));
      await expect(callRpc("videos.updateStatus", { id: gen.id, status: "ready" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });

      const upload = await insertVideo(tx, user.id);
      await callRpc("videos.updateStatus", { id: upload.id, status: "ready" }, { user, tx });
      await callRpc("videos.updateStatus", { id: upload.id, status: "ready" }, { user, tx }); // idempotent
      expect((await tx.select().from(videos).where(eq(videos.id, upload.id)))[0].status).toBe("ready");

      // statuses with their own code path can't be set by hand
      await Promise.all(
        ["scheduled", "publishing", "published", "generating", "failed"].map((status) =>
          expect(callRpc("videos.updateStatus", { id: upload.id, status }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" }),
        ),
      );
      const live = await insertVideo(tx, user.id, { status: "publishing" });
      await expect(callRpc("videos.updateStatus", { id: live.id, status: "ready" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect((await tx.select().from(videos).where(eq(videos.id, live.id)))[0].status).toBe("publishing");
    });
  });
});

describe("videos: scheduled metadata", () => {
  test("enqueues one metadata.generate task per video and reschedules cleanly", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await insertVideo(tx, user.id);
      const key = `metadata:${v.id}`;
      const at = Date.now() + 3_600_000;
      await callRpc("videos.scheduleMetadataForVideo", { id: v.id, scheduledAt: at }, { user, tx });

      const [row] = await tx.select().from(videos).where(eq(videos.id, v.id));
      expect(row.metadataScheduledAt?.getTime()).toBe(at);
      let queued = await tx.select().from(tasks).where(eq(tasks.dedupeKey, key));
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ kind: "metadata.generate", status: "pending", userId: user.id });
      expect(queued[0].payload).toEqual({ videoId: v.id });
      expect(queued[0].runAt.getTime()).toBe(at);

      // a future schedule already exists
      await expect(callRpc("videos.scheduleMetadataForVideo", { id: v.id, scheduledAt: at + 1000 }, { user, tx })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Video already has a pending metadata job scheduled",
      });

      // its time passed without the task running: scheduling again replaces the stale task
      await tx.update(videos).set({ metadataScheduledAt: new Date(Date.now() - 1000) }).where(eq(videos.id, v.id));
      const at2 = Date.now() + 7_200_000;
      await callRpc("videos.scheduleMetadataForVideo", { id: v.id, scheduledAt: at2 }, { user, tx });
      queued = await tx.select().from(tasks).where(eq(tasks.dedupeKey, key));
      expect(queued.filter((t) => t.status === "pending")).toHaveLength(1);
      expect(queued.filter((t) => t.status === "pending")[0].runAt.getTime()).toBe(at2);
      expect(queued.filter((t) => t.status === "cancelled")).toHaveLength(1);

      // only drafts
      const ready = await insertVideo(tx, user.id, { status: "ready" });
      await expect(callRpc("videos.scheduleMetadataForVideo", { id: ready.id, scheduledAt: at }, { user, tx })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Only draft videos can be queued for metadata generation",
      });
    });
  });
});

describe("videos: metadata history", () => {
  test("get returns the newest 10 versions, newest first, in the shape the UI renders", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await insertVideo(tx, user.id, { aiTitle: "current" });
      const other = await insertVideo(tx, user.id);
      const base = Date.now() - 3_600_000;
      await tx.insert(videoMetadataVersions).values([
        ...Array.from({ length: 12 }, (_, i) => ({ videoId: v.id, savedAt: new Date(base + i * 1000), aiTitle: `v-${i}`, aiDescription: i === 11 ? "d" : null, aiTags: i === 11 ? ["x"] : null })),
        { videoId: other.id, savedAt: new Date(base), aiTitle: "someone-elses-video" },
      ]);

      const got = (await callRpc("videos.get", { id: v.id }, { user, tx })) as { metadataHistory: W[] };
      expect(got.metadataHistory).toHaveLength(10);
      expect(got.metadataHistory.map((h) => h.aiTitle)).toEqual(Array.from({ length: 10 }, (_, i) => `v-${11 - i}`));
      expect(got.metadataHistory[0]).toMatchObject({ aiDescription: "d", aiTags: ["x"] });
      expect(typeof got.metadataHistory[0].savedAt).toBe("number");
      expect("aiDescription" in got.metadataHistory[1]).toBe(false); // null fields are omitted on the wire

      const otherGot = (await callRpc("videos.get", { id: other.id }, { user, tx })) as { metadataHistory: W[] };
      expect(otherGot.metadataHistory.map((h) => h.aiTitle)).toEqual(["someone-elses-video"]);
    });
  });
});

describe("videos: bulk operations", () => {
  test("bulkMarkDraftsReady promotes only drafts that have a file", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const withFile = await insertVideo(tx, user.id);
      const processedOnly = await insertVideo(tx, user.id, { rawFileKey: "", processedFileKey: "https://res.cloudinary.com/demo/video/upload/p.mp4" });
      const noFile = await insertVideo(tx, user.id, { rawFileKey: "", rawFileSize: 0 });
      const scheduled = await insertVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: new Date(Date.now() + 1000) });

      const theirs = await insertVideo(tx, (await makeUser()).id);
      expect(await callRpc("videos.bulkMarkDraftsReady", {}, { user, tx })).toEqual({ count: 2 });
      const status = async (id: string) => (await tx.select().from(videos).where(eq(videos.id, id)))[0].status;
      expect(await status(withFile.id)).toBe("ready");
      expect(await status(processedOnly.id)).toBe("ready");
      expect(await status(noFile.id)).toBe("draft");
      expect(await status(scheduled.id)).toBe("scheduled");
      expect(await callRpc("videos.bulkMarkDraftsReady", {}, { user, tx })).toEqual({ count: 0 });
      // other people's drafts are never touched
      expect((await tx.select().from(videos).where(eq(videos.id, theirs.id)))[0].status).toBe("draft");
    });
  });

  test("bulkSwitchLongVideosToVideo only touches long videos with no explicit choice", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const long = await insertVideo(tx, user.id, { duration: 61 });
      const edge = await insertVideo(tx, user.id, { duration: 60 });
      const chosen = await insertVideo(tx, user.id, { duration: 300, publishAs: "short" });
      const unknown = await insertVideo(tx, user.id);

      const theirs = await insertVideo(tx, (await makeUser()).id, { duration: 500 });
      expect(await callRpc("videos.bulkSwitchLongVideosToVideo", {}, { user, tx })).toEqual({ switched: 1 });
      const publishAs = async (id: string) => (await tx.select().from(videos).where(eq(videos.id, id)))[0].publishAs;
      expect(await publishAs(long.id)).toBe("video");
      expect(await publishAs(edge.id)).toBeNull();
      expect(await publishAs(chosen.id)).toBe("short");
      expect(await publishAs(unknown.id)).toBeNull();
      expect(await callRpc("videos.bulkSwitchLongVideosToVideo", {}, { user, tx })).toEqual({ switched: 0 });
      expect((await tx.select().from(videos).where(eq(videos.id, theirs.id)))[0].publishAs).toBeNull(); // not touched
    });
  });
});

describe("videos: create / createGenerated (plan quota)", () => {
  type Tx = Parameters<typeof insertVideo>[0];
  async function setPlan(tx: Tx, userId: string, plan: "free" | "pro") {
    await tx.update(users).set({ plan }).where(eq(users.id, userId));
  }
  /** Force this month's counters to known values (the shared test user may already have a ledger row). */
  async function setLedger(tx: Tx, userId: string, v: { videosUploaded?: number; veoGenerated?: number }) {
    await tx
      .insert(usageLedger)
      .values({ userId, month: monthKey(), videosUploaded: v.videosUploaded ?? 0, veoGenerated: v.veoGenerated ?? 0 })
      .onConflictDoUpdate({ target: [usageLedger.userId, usageLedger.month], set: { videosUploaded: v.videosUploaded ?? 0, veoGenerated: v.veoGenerated ?? 0 } });
  }
  const ledger = async (tx: Tx, userId: string) =>
    (await tx.select().from(usageLedger).where(and(eq(usageLedger.userId, userId), eq(usageLedger.month, monthKey()))))[0];
  const titled = (tx: Tx, userId: string, title: string) => tx.select().from(videos).where(and(eq(videos.userId, userId), eq(videos.title, title)));

  test("create consumes the upload quota and stops at the plan limit", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const mark = `quota-${crypto.randomUUID()}`;
      await setPlan(tx, user.id, "free");
      await setLedger(tx, user.id, { videosUploaded: 9 });

      const id = (await callRpc("videos.create", { title: `  ${mark}  `, rawFileKey: CLOUDINARY, rawFileSize: 123, duration: 12.5, tags: ["a"] }, { user, tx })) as string;
      const [row] = await tx.select().from(videos).where(eq(videos.id, id));
      expect(row).toMatchObject({ userId: user.id, title: mark, status: "draft", rawFileSize: 123, duration: 12.5, sourceType: "upload" });
      expect((await ledger(tx, user.id)).videosUploaded).toBe(10);

      await expect(callRpc("videos.create", { title: `${mark}-over`, rawFileKey: CLOUDINARY, rawFileSize: 1 }, { user, tx })).rejects.toMatchObject({
        code: "PLAN_LIMIT_EXCEEDED",
        message: expect.stringContaining("PLAN_LIMIT_EXCEEDED:videosUploaded:free"),
      });
      expect((await ledger(tx, user.id)).videosUploaded).toBe(10); // the refused call used no quota...
      expect(await titled(tx, user.id, `${mark}-over`)).toHaveLength(0); // ...and left no row
    });
  });

  test("create only accepts Cloudinary files and rejects bad sizes without using quota", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await setPlan(tx, user.id, "pro");
      await setLedger(tx, user.id, { videosUploaded: 3 });
      await Promise.all(
        [
          { title: "x", rawFileKey: "http://169.254.169.254/latest/meta-data", rawFileSize: 1 },
          { title: "x", rawFileKey: "https://res.cloudinary.com.evil.example/x.mp4", rawFileSize: 1 },
          { title: "x", rawFileKey: "https://evil.example/res.cloudinary.com/x.mp4", rawFileSize: 1 },
          { title: "x", rawFileKey: "not a url", rawFileSize: 1 },
          ...(process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ? [{ title: "x", rawFileKey: `https://res.cloudinary.com/${CLOUD}-other/video/upload/x.mp4`, rawFileSize: 1 }] : []), // someone else's cloud
          { title: "x", rawFileKey: `https://user:pw@res.cloudinary.com/${CLOUD}/video/upload/x.mp4`, rawFileSize: 1 },
          { title: "x", rawFileKey: CLOUDINARY, rawFileSize: -1 },
        ].map((args) => expect(callRpc("videos.create", args, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" })),
      );
      expect((await ledger(tx, user.id)).videosUploaded).toBe(3); // invalid input never touches the quota
      // an empty title (file named ".mp4") still creates a row
      const id = (await callRpc("videos.create", { title: "", rawFileKey: CLOUDINARY, rawFileSize: 0 }, { user, tx })) as string;
      expect((await tx.select().from(videos).where(eq(videos.id, id)))[0].title).toBe("Untitled video");
    });
  });

  test("createGenerated makes a placeholder row and fails fast when the plan has no Veo allowance", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const mark = `gen-${crypto.randomUUID()}`;
      await setPlan(tx, user.id, "free");
      await setLedger(tx, user.id, {});
      await expect(callRpc("videos.createGenerated", { title: mark, aiConfig: { prompt: "a cat" } }, { user, tx })).rejects.toMatchObject({
        code: "PLAN_LIMIT_EXCEEDED",
        message: expect.stringContaining("PLAN_LIMIT_EXCEEDED:veoGenerated:free"),
      });

      expect(await titled(tx, user.id, mark)).toHaveLength(0);

      await setPlan(tx, user.id, "pro");
      const id = (await callRpc("videos.createGenerated", { title: mark, aiConfig: { prompt: "a cat", model: "veo-3.1-fast", durationSeconds: 8 } }, { user, tx })) as string;
      const [row] = await tx.select().from(videos).where(eq(videos.id, id));
      expect(row).toMatchObject({ status: "draft", rawFileKey: "", rawFileSize: 0, sourceType: "generate" });
      expect(row.aiConfig).toEqual({ prompt: "a cat", model: "veo-3.1-fast", durationSeconds: 8 });
      expect((await ledger(tx, user.id)).veoGenerated).toBe(0); // consumed by the generation job, not here

      await setLedger(tx, user.id, { veoGenerated: 5 });
      await expect(callRpc("videos.createGenerated", { title: "p", aiConfig: { prompt: "a cat" } }, { user, tx })).rejects.toMatchObject({ code: "PLAN_LIMIT_EXCEEDED" });
    });
  });
});

describe("videos: simple updates", () => {
  test("privacy / publishAs / aiConfig update the owner's row", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await insertVideo(tx, user.id, { aiConfig: { prompt: "old" } });
      await callRpc("videos.updatePrivacyStatus", { id: v.id, privacyStatus: "unlisted" }, { user, tx });
      await callRpc("videos.updatePublishAs", { id: v.id, publishAs: "video" }, { user, tx });
      await callRpc("videos.updateAiConfig", { id: v.id, aiConfig: { prompt: "new", captions: true } }, { user, tx });
      let [row] = await tx.select().from(videos).where(eq(videos.id, v.id));
      expect(row).toMatchObject({ privacyStatus: "unlisted", publishAs: "video" });
      expect(row.aiConfig).toEqual({ prompt: "new", captions: true });
      await callRpc("videos.updateAiConfig", { id: v.id }, { user, tx });
      [row] = await tx.select().from(videos).where(eq(videos.id, v.id));
      expect(row.aiConfig).toBeNull();
      await expect(callRpc("videos.updatePrivacyStatus", { id: v.id, privacyStatus: "secret" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });
});

