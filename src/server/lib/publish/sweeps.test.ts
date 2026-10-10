import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { jobs, videos } from "@/db/schema";
import { enqueueJob } from "@/server/jobs/queue";
import { countQueries, inRolledBackTx } from "@/server/testing";
import { makeDeps, mkJob, mkVideo } from "./dbkit";
import { processDueSchedules, reconcilePublishing, type DueSchedulesOptions } from "./sweeps";
import { FakeWorld } from "./testkit";

setDefaultTimeout(120_000);

const HOUR_AGO = () => new Date(Date.now() - 3_600_000);

describe("reconcilePublishing", () => {
  test("repairs videos whose job vanished, leaves live and recent ones alone", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const stuck = await mkVideo(tx, user.id, { status: "publishing", updatedAt: HOUR_AGO(), title: "stuck" });
      const alive = await mkVideo(tx, user.id, { status: "publishing", updatedAt: HOUR_AGO(), title: "alive" });
      await mkJob(tx, user.id, alive.id, { status: "pending" });
      const recent = await mkVideo(tx, user.id, { status: "publishing", title: "recent" });
      const finished = await mkVideo(tx, user.id, { status: "publishing", updatedAt: HOUR_AGO(), publishedVideoId: "yt1", title: "finished" });

      const { deps, spies } = makeDeps(new FakeWorld(1));
      const out = await reconcilePublishing(tx, deps, { videoIds: [stuck.id, alive.id, recent.id, finished.id] });
      expect(out).toEqual({ failed: 1, published: 1 });

      const status = async (id: string) => (await tx.select({ s: videos.status }).from(videos).where(eq(videos.id, id)))[0].s;
      expect(await status(stuck.id)).toBe("failed");
      expect(await status(alive.id)).toBe("publishing");
      expect(await status(recent.id)).toBe("publishing");
      expect(await status(finished.id)).toBe("published");

      const links = spies.notifications.map((n) => n.link);
      expect(links).toContain(`/video/${stuck.id}`);
      expect(links).not.toContain(`/video/${alive.id}`);
      expect(links).not.toContain(`/video/${recent.id}`);
      expect(links).not.toContain(`/video/${finished.id}`);
      expect(spies.messages.some((m) => m.event === "publishFailure" && m.data.title === "stuck")).toBe(true);

      // idempotent: a second pass repairs nothing of ours again
      const again = makeDeps(new FakeWorld(1));
      await reconcilePublishing(tx, again.deps, { videoIds: [stuck.id, alive.id, recent.id, finished.id] });
      expect(again.spies.notifications.map((n) => n.link)).not.toContain(`/video/${stuck.id}`);
      expect(await tx.select().from(jobs).where(eq(jobs.videoId, stuck.id))).toHaveLength(0);
    });
  });
});

describe("processDueSchedules", () => {
  const FUTURE = new Date(Date.now() + 10 * 365 * 24 * 3_600_000);
  const HOUR_AGO_DUE = () => new Date(Date.now() - 3_600_000);

  /** The pre-change implementation (a transaction with one enqueueJob per claimed row), kept to prove the new one is equivalent. */
  async function referenceProcessDueSchedules(db: DbLike, opts: DueSchedulesOptions = {}): Promise<{ claimed: number; jobsCreated: number }> {
    const batchSize = opts.batchSize ?? 200;
    const maxBatches = opts.maxBatches ?? 10;
    const userFilter = opts.userId ? sql`and user_id = ${opts.userId}` : sql``;
    const idFilter = opts.videoIds && opts.videoIds.length > 0 ? sql`and id in (${sql.join(opts.videoIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
    let claimed = 0;
    let jobsCreated = 0;
    for (let i = 0; i < maxBatches; i++) {
      const batch = await db.transaction(async (tx) => {
        const rows = (await tx.execute(sql`
          update videos
             set status = 'publishing', updated_at = now()
           where id in (
             select id from videos
              where status = 'scheduled' and scheduled_publish_at <= now() and published_video_id is null
                ${userFilter} ${idFilter}
              order by scheduled_publish_at
              limit ${batchSize}
                for update skip locked
           )
          returning id, user_id
        `)) as unknown as { id: string; user_id: string }[];
        let created = 0;
        for (const r of rows) {
          const { created: isNew } = await enqueueJob(tx, { userId: r.user_id, videoId: r.id, type: "publish", runAt: opts.runAt });
          if (isNew) created++;
        }
        return { n: rows.length, created };
      });
      claimed += batch.n;
      jobsCreated += batch.created;
      if (batch.n < batchSize) break;
    }
    return { claimed, jobsCreated };
  }

  const mkDue = (tx: DbLike, userId: string, n: number, over: Partial<typeof videos.$inferInsert> = {}) =>
    Promise.all(Array.from({ length: n }, () => mkVideo(tx, userId, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE(), ...over })));
  const NONE = ["00000000-0000-4000-8000-000000000000"]; // an id filter that matches nothing (an empty list means "no filter")

  test("statements per batch do not depend on how many videos are due", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const counts: Record<number, number> = {};
      for (const n of [0, 1, 20]) {
        const due = await mkDue(tx, user.id, n);
        const ids = due.map((v) => v.id);
        const { result, queries } = await countQueries(() => processDueSchedules(tx, { userId: user.id, videoIds: ids.length ? ids : NONE, runAt: FUTURE }));
        expect(result).toEqual({ claimed: n, jobsCreated: n });
        counts[n] = queries;
        expect(queries).toBeLessThanOrEqual(2);
      }
      expect(counts[1]).toBe(counts[20]);
      expect(counts[0]).toBe(counts[20]);
    });
  });

  test("one statement per batch: batchSize 2 over 5 videos is 3 statements; maxBatches caps the work", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const five = await mkDue(tx, user.id, 5);
      const ids = five.map((v) => v.id);
      const capped = await countQueries(() => processDueSchedules(tx, { userId: user.id, videoIds: ids, runAt: FUTURE, batchSize: 2, maxBatches: 2 }));
      expect(capped.result).toEqual({ claimed: 4, jobsCreated: 4 });
      expect(capped.queries).toBe(2);
      const rest = await countQueries(() => processDueSchedules(tx, { userId: user.id, videoIds: ids, runAt: FUTURE, batchSize: 2 }));
      expect(rest.result).toEqual({ claimed: 1, jobsCreated: 1 });
      expect(rest.queries).toBe(1);
      // an exact multiple costs one extra (empty) batch, as before
      const four = await mkDue(tx, user.id, 4);
      const exact = await countQueries(() => processDueSchedules(tx, { userId: user.id, videoIds: four.map((v) => v.id), runAt: FUTURE, batchSize: 2 }));
      expect(exact.result).toEqual({ claimed: 4, jobsCreated: 4 });
      expect(exact.queries).toBe(3);
    });
  });

  test("claims only due, scheduled, unpublished videos of the filtered user and creates the jobs enqueueJob would", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      const due = await mkDue(tx, user.id, 3);
      const notYet = await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: FUTURE });
      const notScheduled = await mkVideo(tx, user.id, { status: "ready", scheduledPublishAt: HOUR_AGO_DUE() });
      const alreadyOnYoutube = await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE(), publishedVideoId: "yt1" });
      const strangers = await mkVideo(tx, other.id, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE() });
      const all = [...due, notYet, notScheduled, alreadyOnYoutube, strangers].map((v) => v.id);

      const out = await processDueSchedules(tx, { userId: user.id, videoIds: all, runAt: FUTURE });
      expect(out).toEqual({ claimed: 3, jobsCreated: 3 });

      const status = async (id: string) => (await tx.select({ s: videos.status }).from(videos).where(eq(videos.id, id)))[0].s;
      for (const v of due) expect(await status(v.id)).toBe("publishing");
      expect(await status(notYet.id)).toBe("scheduled");
      expect(await status(notScheduled.id)).toBe("ready");
      expect(await status(alreadyOnYoutube.id)).toBe("scheduled");
      expect(await status(strangers.id)).toBe("scheduled");

      const created = await tx.select().from(jobs).where(inArray(jobs.videoId, all));
      expect(created.map((j) => j.videoId).sort()).toEqual(due.map((v) => v.id).sort());
      for (const j of created) {
        expect(j).toMatchObject({ userId: user.id, type: "publish", status: "pending", attempts: 0, maxAttempts: 3, metadata: null, error: null, startedAt: null, completedAt: null, lockedAt: null });
        expect(j.runAt.getTime()).toBe(FUTURE.getTime());
      }
      expect(await processDueSchedules(tx, { userId: user.id, videoIds: all, runAt: FUTURE })).toEqual({ claimed: 0, jobsCreated: 0 }); // idempotent
      expect(await tx.select().from(jobs).where(inArray(jobs.videoId, all))).toHaveLength(3);
    });
  });

  test("without a runAt the jobs are runnable now", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const [v] = await mkDue(tx, user.id, 1);
      const t0 = Date.now();
      await processDueSchedules(tx, { userId: user.id, videoIds: [v.id] });
      const [job] = await tx.select().from(jobs).where(eq(jobs.videoId, v.id));
      expect(Math.abs(job.runAt.getTime() - t0)).toBeLessThan(60_000);
    });
  });

  test("a video that already has an active publish job is claimed but keeps that job (no second job)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const pending = await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE() });
      const processing = await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE() });
      const fresh = await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE() });
      const finished = await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE() }); // old COMPLETED job: not active
      const existingPending = await mkJob(tx, user.id, pending.id, { status: "pending", attempts: 0 });
      const existingProcessing = await mkJob(tx, user.id, processing.id, { status: "processing" });
      const old = await mkJob(tx, user.id, finished.id, { status: "completed" });
      const ids = [pending.id, processing.id, fresh.id, finished.id];

      expect(await processDueSchedules(tx, { userId: user.id, videoIds: ids, runAt: FUTURE })).toEqual({ claimed: 4, jobsCreated: 2 });

      const byVideo = async (id: string) => await tx.select().from(jobs).where(eq(jobs.videoId, id));
      expect((await byVideo(pending.id)).map((j) => j.id)).toEqual([existingPending.id]);
      expect((await byVideo(processing.id)).map((j) => j.id)).toEqual([existingProcessing.id]);
      expect((await byVideo(processing.id))[0].status).toBe("processing");
      expect(await byVideo(fresh.id)).toHaveLength(1);
      expect((await byVideo(finished.id)).map((j) => j.status).sort()).toEqual(["completed", "pending"]);
      expect((await byVideo(finished.id)).find((j) => j.status === "completed")?.id).toBe(old.id);
      for (const id of ids) expect((await tx.select({ s: videos.status }).from(videos).where(eq(videos.id, id)))[0].s).toBe("publishing");
    });
  });

  test("gives exactly the same result and the same rows as the transaction-per-batch implementation it replaced", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const build = async () => {
        const due = await mkDue(tx, user.id, 5);
        const conflict = await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE() });
        await mkJob(tx, user.id, conflict.id, { status: "pending", attempts: 0 });
        const skipped = [
          await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: FUTURE }),
          await mkVideo(tx, user.id, { status: "ready", scheduledPublishAt: HOUR_AGO_DUE() }),
          await mkVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: HOUR_AGO_DUE(), publishedVideoId: "yt" }),
        ];
        return { all: [...due, conflict, ...skipped].map((v) => v.id), roles: [...due.map(() => "due"), "conflict", "future", "not-scheduled", "published"] };
      };
      const observe = async (fx: Awaited<ReturnType<typeof build>>) => {
        const rows: unknown[] = [];
        for (const [i, id] of fx.all.entries()) {
          const [v] = await tx.select({ status: videos.status }).from(videos).where(eq(videos.id, id));
          const js = (await tx.select().from(jobs).where(eq(jobs.videoId, id))).map((j) => ({ type: j.type, status: j.status, attempts: j.attempts, maxAttempts: j.maxAttempts, metadata: j.metadata, runAt: j.runAt.getTime(), userId: j.userId }));
          rows.push({ role: fx.roles[i], status: v.status, jobs: js });
        }
        return rows;
      };

      for (const batchSize of [200, 2]) {
        const a = await build();
        const b = await build();
        const before = await countQueries(() => referenceProcessDueSchedules(tx, { userId: user.id, videoIds: a.all, runAt: FUTURE, batchSize }));
        const after = await countQueries(() => processDueSchedules(tx, { userId: user.id, videoIds: b.all, runAt: FUTURE, batchSize }));
        expect(after.result).toEqual(before.result);
        expect(after.result).toEqual({ claimed: 6, jobsCreated: 5 });
        expect(await observe(b)).toEqual(await observe(a));
        expect(after.queries).toBeLessThan(before.queries);
      }
    });
  });
});
