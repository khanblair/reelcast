import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { jobs, settings, tasks, videos } from "@/db/schema";
import { NonRetryableError } from "@/server/jobs/handlers";
import { enqueueTask } from "@/server/jobs/queue";
import { inRolledBackTx } from "@/server/testing";
import { runAutoPublish } from "./autoPublish";
import { makeDeps, mkVideo } from "./dbkit";
import { computeNextAutoPublishAt } from "./schedule";
import { FakeWorld, cloudUrl } from "./testkit";

setDefaultTimeout(120_000);

const H = 3_600_000;
const url = (name: string) => cloudUrl(`video/upload/v1/${name}.mp4`);

async function setup(tx: DbLike, userId: string, over: Partial<typeof settings.$inferInsert> = {}) {
  // Only this test's videos may be "ready" for the user inside the (rolled back) transaction.
  await tx.update(videos).set({ status: "draft" }).where(and(eq(videos.userId, userId), eq(videos.status, "ready")));
  const base = {
    autoPublishEnabled: true,
    autoPublishIntervalMs: 3 * H,
    autoPublishCount: 2,
    autoPublishPrivacy: "unlisted" as const,
    autoPublishNextAt: new Date(),
    autoPublishTimeSlots: null,
    autoPublishTimezoneOffset: null,
    ...over,
  };
  await tx.insert(settings).values({ userId, ...base }).onConflictDoUpdate({ target: settings.userId, set: base });
  const { task } = await enqueueTask(tx, { kind: "autoPublish.run", payload: { userId }, userId, dedupeKey: `autoPublish:test:${randomUUID()}` });
  const row = async () => (await tx.select().from(settings).where(eq(settings.userId, userId)))[0];
  return { task, row };
}

const ready = (tx: DbLike, userId: string, name: string, over: Partial<typeof videos.$inferInsert> = {}) =>
  mkVideo(tx, userId, { status: "ready", title: name, rawFileKey: url(name), createdAt: new Date(Date.now() - 1000 * (over.publishOrder ?? 0) - Math.random()), ...over });

const jobVideoIds = async (tx: DbLike, ids: string[]) =>
  new Set((await tx.select({ v: jobs.videoId }).from(jobs).where(sql`${jobs.videoId} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)).map((r) => r.v));

describe("autoPublish.run", () => {
  test("publishes the next `count` ready videos in publish_order, stamps privacy, and reschedules by the interval", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task, row } = await setup(tx, user.id);
      const v3 = await ready(tx, user.id, "three", { publishOrder: 3 });
      const v1 = await ready(tx, user.id, "one", { publishOrder: 1 });
      const vNull = await ready(tx, user.id, "unordered");
      const v2 = await ready(tx, user.id, "two", { publishOrder: 2 });
      const { deps } = makeDeps(new FakeWorld(1));

      const before = Date.now();
      const out = await runAutoPublish(task, { db: tx, now: new Date() }, deps);

      expect(await jobVideoIds(tx, [v1.id, v2.id, v3.id, vNull.id])).toEqual(new Set([v1.id, v2.id]));
      for (const v of [v1, v2]) {
        const [after] = await tx.select().from(videos).where(eq(videos.id, v.id));
        expect(after.status).toBe("publishing");
        expect(after.privacyStatus).toBe("unlisted");
      }
      for (const v of [v3, vNull]) expect((await tx.select().from(videos).where(eq(videos.id, v.id)))[0].status).toBe("ready");

      expect(out).toBeDefined();
      const wait = (out as { rescheduleInMs: number }).rescheduleInMs;
      expect(Math.abs(wait - 3 * H)).toBeLessThan(10_000);
      const next = (await row()).autoPublishNextAt!.getTime();
      expect(Math.abs(next - (before + 3 * H))).toBeLessThan(10_000);
    });
  });

  test("videos without a publish_order go after ordered ones, oldest first", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task } = await setup(tx, user.id, { autoPublishCount: 2 });
      const newer = await ready(tx, user.id, "newer", { createdAt: new Date(Date.now() - 1_000) });
      const older = await ready(tx, user.id, "older", { createdAt: new Date(Date.now() - 50_000) });
      const ordered = await ready(tx, user.id, "ordered", { publishOrder: 9 });
      await runAutoPublish(task, { db: tx, now: new Date() }, makeDeps(new FakeWorld(1)).deps);
      expect(await jobVideoIds(tx, [newer.id, older.id, ordered.id])).toEqual(new Set([ordered.id, older.id]));
    });
  });

  test("files found dead are skipped, flagged, reported once, and healthy videos behind them still publish", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task } = await setup(tx, user.id, { autoPublishCount: 1 });
      const dead = await ready(tx, user.id, "dead-file", { publishOrder: 1, aiTitle: "Dead one" });
      const good = await ready(tx, user.id, "good", { publishOrder: 2 });
      const { deps, spies } = makeDeps(new FakeWorld(1), { isFileMissing: async (u) => u.includes("dead-file") });

      await runAutoPublish(task, { db: tx, now: new Date() }, deps);

      const [d] = await tx.select().from(videos).where(eq(videos.id, dead.id));
      expect(d.storageMissing).toBe(true);
      expect(d.status).toBe("failed");
      expect(await jobVideoIds(tx, [dead.id, good.id])).toEqual(new Set([good.id]));
      const warnings = spies.messages.filter((m) => m.event === "storageWarning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].data.titles).toEqual(["Dead one"]);
    });
  });

  test("time slots: the next run is the next local slot, computed by the shared function", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const cfg = { autoPublishTimeSlots: [9, 18], autoPublishTimezoneOffset: 5 };
      const { task, row } = await setup(tx, user.id, cfg);
      await ready(tx, user.id, "slotvid");
      const out = (await runAutoPublish(task, { db: tx, now: new Date() }, makeDeps(new FakeWorld(1)).deps)) as { rescheduleInMs: number };
      const expected = computeNextAutoPublishAt({ autoPublishIntervalMs: 3 * H, ...cfg }, new Date());
      expect(Math.abs((await row()).autoPublishNextAt!.getTime() - expected.getTime())).toBeLessThan(5_000);
      expect(Math.abs(out.rescheduleInMs - (expected.getTime() - Date.now()))).toBeLessThan(5_000);
    });
  });

  test("disabled auto-publish ends the chain without queueing anything", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task, row } = await setup(tx, user.id, { autoPublishEnabled: false });
      const v = await ready(tx, user.id, "idle");
      const nextBefore = (await row()).autoPublishNextAt;
      expect(await runAutoPublish(task, { db: tx, now: new Date() }, makeDeps(new FakeWorld(1)).deps)).toBeUndefined();
      expect(await jobVideoIds(tx, [v.id])).toEqual(new Set());
      expect((await row()).autoPublishNextAt).toEqual(nextBefore);
    });
  });

  test("an error in the batch still schedules the next run (the chain never dies) and records the error", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task, row } = await setup(tx, user.id);
      await ready(tx, user.id, "boom");
      const { deps } = makeDeps(new FakeWorld(1), {
        isFileMissing: async () => {
          throw new Error("storage exploded");
        },
      });
      const origError = console.error;
      console.error = () => {};
      let out: unknown;
      try {
        out = await runAutoPublish(task, { db: tx, now: new Date() }, deps);
      } finally {
        console.error = origError;
      }
      expect(Math.abs((out as { rescheduleInMs: number }).rescheduleInMs - 3 * H)).toBeLessThan(10_000);
      expect(Math.abs((await row()).autoPublishNextAt!.getTime() - (Date.now() + 3 * H))).toBeLessThan(10_000);
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
      expect(t.lastError).toBe("storage exploded");
    });
  });

  test("a user who restarts auto-publish with a new schedule while a batch runs keeps their time", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task, row } = await setup(tx, user.id);
      await ready(tx, user.id, "restart");
      const theirs = new Date(Date.now() + 1 * H);
      const { deps } = makeDeps(new FakeWorld(1), {
        isFileMissing: async () => {
          await tx.update(settings).set({ autoPublishNextAt: theirs }).where(eq(settings.userId, user.id));
          return false;
        },
      });
      const out = (await runAutoPublish(task, { db: tx, now: new Date() }, deps)) as { rescheduleInMs: number };
      expect(Math.abs(out.rescheduleInMs - 1 * H)).toBeLessThan(10_000);
      expect((await row()).autoPublishNextAt).toEqual(theirs);
    });
  });

  test("stopped while the batch ran: no further run is scheduled", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task } = await setup(tx, user.id);
      await ready(tx, user.id, "stopme");
      const { deps } = makeDeps(new FakeWorld(1), {
        isFileMissing: async () => {
          await tx.update(settings).set({ autoPublishEnabled: false, autoPublishNextAt: null }).where(eq(settings.userId, user.id));
          return false;
        },
      });
      expect(await runAutoPublish(task, { db: tx, now: new Date() }, deps)).toBeUndefined();
    });
  });

  test("a payload without a user id is a permanent error", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const { task } = await enqueueTask(tx, { kind: "autoPublish.run", payload: {}, dedupeKey: `autoPublish:test:${randomUUID()}` });
      await expect(runAutoPublish(task, { db: tx, now: new Date() }, makeDeps(new FakeWorld(1)).deps)).rejects.toBeInstanceOf(NonRetryableError);
    });
  });
});

/**
 * A throw outside the batch used to reach the queue, which retries a failing task at 30s and 60s and then marks the row
 * `failed`: the chain was dead while `auto_publish_enabled` stayed true. These tests inject the failure at the db handle.
 */
describe("autoPublish.run keeps the chain alive when an infrastructure step throws", () => {
  type Faults = { failSelect?: boolean; failSettingsUpdate?: boolean };
  /** `faults` is read on every call, so a test can arm a fault in the middle of a run. */
  function faulty(tx: DbLike, faults: Faults): DbLike {
    return new Proxy(tx, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "select" && faults.failSelect) {
          return () => {
            faults.failSelect = false; // a blip: only the first read fails
            throw new Error("connection reset");
          };
        }
        if (prop === "update") {
          return (table: unknown) => {
            if (table === settings && faults.failSettingsUpdate) throw new Error("commit lost");
            return (value as (t: unknown) => unknown).call(target, table);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as DbLike;
  }

  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = { error: console.error, warn: console.warn };
    console.error = () => {};
    console.warn = () => {};
    try {
      return await fn();
    } finally {
      console.error = orig.error;
      console.warn = orig.warn;
    }
  };

  test("a failing settings read re-pends the task with a short backoff instead of throwing, and records why", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task } = await setup(tx, user.id);
      const v = await ready(tx, user.id, "untouched");
      const out = (await quiet(() => runAutoPublish(task, { db: faulty(tx, { failSelect: true }), now: new Date() }, makeDeps(new FakeWorld(1)).deps))) as {
        rescheduleInMs: number;
        payload: Record<string, unknown>;
      };
      expect(Math.abs(out.rescheduleInMs - 60_000)).toBeLessThan(1_000);
      expect(out.payload).toEqual({ userId: user.id, failures: 1 });
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
      expect(t.lastError).toBe("connection reset");
      expect(await jobVideoIds(tx, [v.id])).toEqual(new Set()); // no batch ran before the read succeeded
    });
  });

  test("the backoff doubles with every consecutive failure and is capped at 30 minutes", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task } = await setup(tx, user.id);
      const wait = async (failures: number) => {
        const t = { ...task, payload: { userId: user.id, failures } };
        const out = (await quiet(() => runAutoPublish(t, { db: faulty(tx, { failSelect: true }), now: new Date() }, makeDeps(new FakeWorld(1)).deps))) as {
          rescheduleInMs: number;
          payload: { failures: number };
        };
        return { ms: out.rescheduleInMs, failures: out.payload.failures };
      };
      expect(await wait(0)).toEqual({ ms: 60_000, failures: 1 });
      expect(await wait(1)).toEqual({ ms: 120_000, failures: 2 });
      expect(await wait(3)).toEqual({ ms: 480_000, failures: 4 });
      expect(await wait(5)).toEqual({ ms: 30 * 60_000, failures: 6 });
      expect(await wait(40)).toEqual({ ms: 30 * 60_000, failures: 41 });
      expect(await wait(-3)).toEqual({ ms: 60_000, failures: 1 }); // a damaged counter starts over
    });
  });

  test("a successful run clears the failure counter and keeps the rest of the payload", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task } = await setup(tx, user.id);
      const t = { ...task, payload: { userId: user.id, failures: 4, extra: "kept" } };
      const out = (await runAutoPublish(t, { db: tx, now: new Date() }, makeDeps(new FakeWorld(1)).deps)) as { rescheduleInMs: number; payload?: Record<string, unknown> };
      expect(Math.abs(out.rescheduleInMs - 3 * H)).toBeLessThan(10_000);
      expect(out.payload).toEqual({ userId: user.id, extra: "kept" });
    });
  });

  test("a run that never failed returns no payload (the stored one is left alone)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task } = await setup(tx, user.id);
      const out = (await runAutoPublish(task, { db: tx, now: new Date() }, makeDeps(new FakeWorld(1)).deps)) as { payload?: unknown };
      expect(out.payload).toBeUndefined();
    });
  });

  test("a failure AFTER the batch reschedules at the normal next time, never sooner, and the batch ran exactly once", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task, row } = await setup(tx, user.id, { autoPublishCount: 1 });
      const v = await ready(tx, user.id, "once");
      const staleNext = (await row()).autoPublishNextAt;
      const out = (await quiet(() => runAutoPublish(task, { db: faulty(tx, { failSettingsUpdate: true }), now: new Date() }, makeDeps(new FakeWorld(1)).deps))) as {
        rescheduleInMs: number;
        payload?: unknown;
      };
      // Retrying in 60s would claim and publish another video. The interval is 3h.
      expect(Math.abs(out.rescheduleInMs - 3 * H)).toBeLessThan(10_000);
      expect(out.payload).toBeUndefined();
      expect(await jobVideoIds(tx, [v.id])).toEqual(new Set([v.id]));
      expect((await row()).autoPublishNextAt).toEqual(staleNext); // the failed write left it; the next run's compare-and-swap repairs it
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
      expect(t.lastError).toBe("commit lost");
    });
  });

  test("a user who stopped auto-publish is still not rescheduled (the chain ends on purpose)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const { task } = await setup(tx, user.id, { autoPublishEnabled: false });
      expect(await runAutoPublish(task, { db: faulty(tx, {}), now: new Date() }, makeDeps(new FakeWorld(1)).deps)).toBeUndefined();
    });
  });
});
