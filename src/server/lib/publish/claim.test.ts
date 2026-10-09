/**
 * Concurrency tests need REAL committed rows (a rolled-back transaction cannot race another connection),
 * so they create throwaway rows tagged with MARK and delete them afterwards. Jobs are created with a
 * far-future run_at and nothing here has a real file, channel or notification, so a `next dev` tick
 * running at the same time can neither pick them up nor reach an external service.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, users, videos, youtubeChannels } from "@/db/schema";
import { publishNow } from "@/server/modules/actions/publishNow";
import { callRpc, inRolledBackTx } from "@/server/testing";
import { claimAndEnqueuePublish } from "./claim";
import { makeDeps, mkChannel, mkJob, mkVideo } from "./dbkit";
import { runPublishJob } from "./run";
import { processDueSchedules } from "./sweeps";
import { CLOUD_URL, FakeWorld, KIB256 } from "./testkit";

setDefaultTimeout(120_000);

const MARK = `__c1_${Date.now()}`;
// Years ahead: if a run is ever interrupted before afterAll, leftover jobs cannot become runnable for a long time.
const FUTURE = new Date(Date.now() + 10 * 365 * 24 * 3_600_000);
let userId = "";
let createdUser = false;
const videoIds: string[] = [];
const channelIds: string[] = [];

// A non-Cloudinary key: nothing created here can ever be uploaded, even if a real runner picked it up.
async function mk(over: Partial<typeof videos.$inferInsert> = {}) {
  const v = await mkVideo(db, userId, { title: `${MARK} v`, rawFileKey: "x", ...over });
  videoIds.push(v.id);
  return v;
}

beforeAll(async () => {
  // Rows left behind by an interrupted earlier run (only ones created by this file: marker prefix / test channel ids).
  await db.delete(videos).where(like(videos.title, "\\_\\_c1\\_%"));
  await db.delete(youtubeChannels).where(like(youtubeChannels.channelId, "UC\\_test\\_%"));
  const rows = (await db.execute(sql`select id, email from auth.users order by created_at limit 1`)) as unknown as { id: string; email: string }[];
  userId = rows[0].id;
  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  if (!existing) {
    await db.insert(users).values({ id: userId, email: rows[0].email });
    createdUser = true;
  }
});

afterAll(async () => {
  if (videoIds.length) await db.delete(videos).where(inArray(videos.id, videoIds)); // cascades jobs
  if (channelIds.length) await db.delete(youtubeChannels).where(inArray(youtubeChannels.id, channelIds));
  if (createdUser) await db.delete(users).where(eq(users.id, userId));
});

describe("claimAndEnqueuePublish: compare-and-swap", () => {
  test("ten simultaneous claims of one ready video: exactly one wins and exactly one job exists", async () => {
    const v = await mk({ status: "ready" });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimAndEnqueuePublish(db, { userId, videoId: v.id, fromStates: ["ready", "scheduled"], runAt: FUTURE })),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) expect(r).toEqual({ ok: false, reason: "bad_state", status: "publishing" });

    const rows = await db.select().from(jobs).where(eq(jobs.videoId, v.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("publish");
    const [after] = await db.select().from(videos).where(eq(videos.id, v.id));
    expect(after.status).toBe("publishing");
  });

  test("only the caller's allowed states are claimable; strangers' videos look like missing ones", async () => {
    const scheduled = await mk({ status: "scheduled" });
    expect(await claimAndEnqueuePublish(db, { userId, videoId: scheduled.id, fromStates: ["ready"], runAt: FUTURE })).toEqual({
      ok: false,
      reason: "bad_state",
      status: "scheduled",
    });
    expect((await db.select().from(jobs).where(eq(jobs.videoId, scheduled.id))).length).toBe(0); // no job without the claim

    expect(await claimAndEnqueuePublish(db, { userId: randomUUID(), videoId: scheduled.id, fromStates: ["scheduled"], runAt: FUTURE })).toEqual({ ok: false, reason: "not_found" });
    expect(await claimAndEnqueuePublish(db, { userId, videoId: randomUUID(), fromStates: ["scheduled"], runAt: FUTURE })).toEqual({ ok: false, reason: "not_found" });

    const ok = await claimAndEnqueuePublish(db, { userId, videoId: scheduled.id, fromStates: ["ready", "scheduled"], privacyStatus: "unlisted", runAt: FUTURE });
    expect(ok.ok).toBe(true);
    const [after] = await db.select().from(videos).where(eq(videos.id, scheduled.id));
    expect(after.privacyStatus).toBe("unlisted");
  });

  test("a video that already has a YouTube id can never be claimed", async () => {
    const v = await mk({ status: "ready", publishedVideoId: "abc" });
    expect(await claimAndEnqueuePublish(db, { userId, videoId: v.id, fromStates: ["ready"], runAt: FUTURE })).toMatchObject({ ok: false, reason: "bad_state" });
  });

  test("if the job insert fails, the status change is rolled back too (no 'publishing' video without a job)", async () => {
    const v = await mk({ status: "ready" });
    // An invalid run_at makes the job INSERT throw after the status UPDATE already ran inside the helper's transaction.
    await expect(claimAndEnqueuePublish(db, { userId, videoId: v.id, fromStates: ["ready"], runAt: new Date("not a date") })).rejects.toBeDefined();
    const [after] = await db.select().from(videos).where(eq(videos.id, v.id));
    expect(after.status).toBe("ready");
    expect(await db.select().from(jobs).where(eq(jobs.videoId, v.id))).toHaveLength(0);
  });
});

describe("publishNow rpc", () => {
  const reg = { publishNow };

  test("queues a publish for the caller's ready video and refuses a second click", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { status: "ready" });
      expect(await callRpc("publishNow", { videoId: v.id }, { user, tx }, reg)).toBeNull();
      const [after] = await tx.select().from(videos).where(eq(videos.id, v.id));
      expect(after.status).toBe("publishing");
      expect((await tx.select().from(jobs).where(eq(jobs.videoId, v.id))).map((j) => j.type)).toEqual(["publish"]);

      await expect(callRpc("publishNow", { videoId: v.id }, { user, tx }, reg)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: 'Cannot publish video with status "publishing". Video must be "ready" or "scheduled".',
      });
    });
  });

  test("scheduled videos can be published immediately; drafts cannot; unknown ids are NOT_FOUND", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const scheduled = await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: FUTURE });
      await callRpc("publishNow", { videoId: scheduled.id }, { user, tx }, reg);
      const draft = await mkVideo(tx, user.id, { status: "draft" });
      await expect(callRpc("publishNow", { videoId: draft.id }, { user, tx }, reg)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("publishNow", { videoId: randomUUID() }, { user, tx }, reg)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("publishNow", { videoId: "nope" }, { user, tx }, reg)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("publishNow", { videoId: draft.id }, { user: null }, reg)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    });
  });
});

describe("processDueSchedules", () => {
  test("three sweeps running at once create exactly one job per due video; future videos are untouched", async () => {
    const due = await Promise.all(
      Array.from({ length: 5 }, () => mk({ status: "scheduled", scheduledPublishAt: new Date(Date.now() - 60_000) })),
    );
    const notDue = await mk({ status: "scheduled", scheduledPublishAt: FUTURE });
    const ids = [...due.map((d) => d.id), notDue.id];

    const runs = await Promise.all([1, 2, 3].map(() => processDueSchedules(db, { userId, videoIds: ids, runAt: FUTURE })));
    expect(runs.reduce((n, r) => n + r.claimed, 0)).toBeLessThanOrEqual(5);

    const dueIds = due.map((d) => d.id);
    const rows = await db.select().from(jobs).where(inArray(jobs.videoId, dueIds));
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.videoId)).size).toBe(5);
    const after = await db.select({ id: videos.id, status: videos.status }).from(videos).where(inArray(videos.id, ids));
    for (const a of after) expect(a.status).toBe(a.id === notDue.id ? "scheduled" : "publishing");
    expect((await db.select().from(jobs).where(eq(jobs.videoId, notDue.id))).length).toBe(0);

    // Running it again changes nothing.
    expect(await processDueSchedules(db, { userId, videoIds: ids, runAt: FUTURE })).toEqual({ claimed: 0, jobsCreated: 0 });
    expect(await db.select().from(jobs).where(inArray(jobs.videoId, dueIds))).toHaveLength(5);
  });
});

describe("runPublishJob: exclusive lease", () => {
  test("two simultaneous runs of the same job: exactly one proceeds, one YouTube session is created", async () => {
    const ch = await mkChannel(db, userId);
    channelIds.push(ch.id);
    // Inert if the run is ever interrupted: 'failed' videos and 'completed' jobs are never picked up by anything.
    const v = await mk({ status: "failed", youtubeChannelId: ch.channelId, rawFileKey: CLOUD_URL });
    const job = await mkJob(db, userId, v.id, { status: "completed" });
    const world = new FakeWorld(2 * KIB256);
    const { deps, spies } = makeDeps(world);

    // Hold run A inside its first request so run B starts while A owns the lease.
    let release!: () => void;
    world.setGate(new Promise<void>((r) => (release = r)));
    let aStarted!: () => void;
    const started = new Promise<void>((r) => (aStarted = r));
    world.onFetch = () => aStarted();

    const ctx = { db, now: new Date() };
    const runA = runPublishJob(job, ctx, deps, { chunkSize: KIB256, budgetMs: 1_000_000 });
    await started;
    const b = await runPublishJob(job, ctx, deps, { chunkSize: KIB256, budgetMs: 1_000_000 });
    expect(b).toEqual({ deferMs: 15_000 }); // lost the lease: comes back later, no work, no attempt used
    release();
    const a = await runA;

    expect(a).toMatchObject({ metadata: { youtubeVideoId: "yt_video_1" } });
    expect(world.initiated).toBe(1);
    expect(spies.quota).toHaveLength(1);
    expect(spies.notifications).toHaveLength(1);
    const [row] = await db.select({ metadata: jobs.metadata }).from(jobs).where(eq(jobs.id, job.id));
    expect(JSON.stringify(row.metadata ?? {})).not.toContain("lease");
    const [after] = await db.select().from(videos).where(eq(videos.id, v.id));
    expect(after.status).toBe("published");
  });
});
