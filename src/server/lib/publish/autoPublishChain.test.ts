/**
 * The recovery sweep for dead auto-publish chains. Every test runs in a rolled-back transaction and names its own
 * synthetic users in `userIds` (the test seam), so it can neither read nor lock the real users' settings and tasks.
 * `now` is a fixed Date handed to the function and every row is seeded relative to it, so no timing here depends on how
 * long the remote database takes to answer.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { settings, tasks } from "@/db/schema";
import { enqueueTask } from "@/server/jobs/queue";
import { callRpc, countQueries, inRolledBackTx } from "@/server/testing";
import { AUTO_PUBLISH_KIND, RECOVER_BATCH, autoPublishKey, recoverAutoPublishChains } from "./autoPublishChain";

setDefaultTimeout(120_000);

const MIN = 60_000;
const H = 60 * MIN;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);

type Over = Partial<typeof settings.$inferInsert>;
const auto = (tx: DbLike, userId: string, over: Over = {}) =>
  tx.insert(settings).values({ userId, autoPublishEnabled: true, autoPublishIntervalMs: 6 * H, autoPublishCount: 1, autoPublishNextAt: ago(2 * H), ...over });

const chain = (tx: DbLike, userId: string) => tx.select().from(tasks).where(eq(tasks.dedupeKey, autoPublishKey(userId)));
const live = async (tx: DbLike, userId: string) => (await chain(tx, userId)).filter((t) => t.status === "pending" || t.status === "running");
const liveTask = (tx: DbLike, userId: string, status: "pending" | "running", over: Partial<typeof tasks.$inferInsert> = {}) =>
  tx.insert(tasks).values({ kind: AUTO_PUBLISH_KIND, userId, payload: { userId }, dedupeKey: autoPublishKey(userId), status, runAt: new Date(now.getTime() + H), ...over });

describe("recoverAutoPublishChains", () => {
  test("restarts the chain of a user whose next run is long overdue and who has no task", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await auto(tx, user.id);
      const r = await recoverAutoPublishChains(tx, now, { userIds: [user.id] });
      expect(r).toEqual({ found: 1, restarted: 1, failed: [] });

      const t = await live(tx, user.id);
      expect(t).toHaveLength(1);
      expect(t[0]).toMatchObject({ kind: "autoPublish.run", status: "pending", userId: user.id, payload: { userId: user.id }, dedupeKey: `autoPublish:${user.id}` });
      expect(t[0].runAt.getTime()).toBe(now.getTime()); // due now: the overdue run happens on this tick's drain
    });
  });

  test("a user with a live task is left alone, pending or running, even when that task is itself late", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      await auto(tx, user.id);
      await auto(tx, other.id);
      await liveTask(tx, user.id, "pending", { runAt: ago(3 * H) }); // overdue in the queue: the tick has not drained it, not a dead chain
      await liveTask(tx, other.id, "running", { lockedAt: ago(MIN) });

      expect(await recoverAutoPublishChains(tx, now, { userIds: [user.id, other.id] })).toEqual({ found: 0, restarted: 0, failed: [] });
      expect(await chain(tx, user.id)).toHaveLength(1);
      expect(await chain(tx, other.id)).toHaveLength(1);
    });
  });

  test("a finished, failed or cancelled run does not count as alive", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await auto(tx, user.id);
      for (const status of ["failed", "done", "cancelled"] as const) {
        await tx.insert(tasks).values({ kind: AUTO_PUBLISH_KIND, userId: user.id, payload: { userId: user.id }, dedupeKey: autoPublishKey(user.id), status, runAt: ago(3 * H) });
      }
      expect(await recoverAutoPublishChains(tx, now, { userIds: [user.id] })).toMatchObject({ found: 1, restarted: 1 });
      expect(await live(tx, user.id)).toHaveLength(1);
      expect(await chain(tx, user.id)).toHaveLength(4); // the history is kept
    });
  });

  test("users who stopped auto-publish, never set it, have no next run, or are not overdue are not touched", async () => {
    await inRolledBackTx(async ({ tx, makeUser }) => {
      const users = {
        off: await makeUser(),
        offNull: await makeUser(),
        noNextAt: await makeUser(),
        notYetOverdue: await makeUser(),
        future: await makeUser(),
      };
      await auto(tx, users.off.id, { autoPublishEnabled: false });
      await auto(tx, users.offNull.id, { autoPublishEnabled: null });
      await auto(tx, users.noNextAt.id, { autoPublishNextAt: null });
      await auto(tx, users.notYetOverdue.id, { autoPublishNextAt: ago(10 * MIN - 1_000) }); // 9m59s late: a busy tick, not a dead chain
      await auto(tx, users.future.id, { autoPublishNextAt: new Date(now.getTime() + H) });

      const ids = Object.values(users).map((u) => u.id);
      expect(await recoverAutoPublishChains(tx, now, { userIds: ids })).toEqual({ found: 0, restarted: 0, failed: [] });
      for (const id of ids) expect(await chain(tx, id)).toHaveLength(0);
    });
  });

  test("the overdue threshold is 10 minutes", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const late = await makeUser();
      await auto(tx, user.id, { autoPublishNextAt: ago(10 * MIN + 1_000) });
      await auto(tx, late.id, { autoPublishNextAt: ago(10 * MIN) }); // exactly 10 minutes: not "more than"
      const r = await recoverAutoPublishChains(tx, now, { userIds: [user.id, late.id] });
      expect(r).toMatchObject({ found: 1, restarted: 1 });
      expect(await live(tx, user.id)).toHaveLength(1);
      expect(await live(tx, late.id)).toHaveLength(0);
    });
  });

  test("a second run does not duplicate the chain", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await auto(tx, user.id);
      const first = await recoverAutoPublishChains(tx, now, { userIds: [user.id] });
      const second = await recoverAutoPublishChains(tx, now, { userIds: [user.id] });
      expect(first.restarted).toBe(1);
      expect(second).toEqual({ found: 0, restarted: 0, failed: [] });
      expect(await chain(tx, user.id)).toHaveLength(1);
    });
  });

  test("a chain that appears between the lookup and the enqueue (a user pressing Start) is kept, not duplicated", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await auto(tx, user.id);
      // The first statement of the sweep is the lookup; right after it returns, the user starts auto-publish.
      let calls = 0;
      const racing = new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "execute") return typeof value === "function" ? value.bind(target) : value;
          return async (...args: unknown[]) => {
            const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            if (++calls === 1) await enqueueTask(target as DbLike, { kind: AUTO_PUBLISH_KIND, userId: user.id, payload: { userId: user.id }, dedupeKey: autoPublishKey(user.id) });
            return out;
          };
        },
      }) as DbLike;

      const r = await recoverAutoPublishChains(racing, now, { userIds: [user.id] });
      expect(r).toEqual({ found: 1, restarted: 0, failed: [] }); // found, but the live row won
      expect(await chain(tx, user.id)).toHaveLength(1);
    });
  });

  test("restarts at most `limit` chains per run, most overdue first, and the rest on later runs", async () => {
    await inRolledBackTx(async ({ tx, makeUser }) => {
      const users: Awaited<ReturnType<typeof makeUser>>[] = [];
      for (let i = 0; i < 5; i++) users.push(await makeUser());
      // user 0 is the least overdue (11 min), user 4 the most (~4 h)
      for (const [i, u] of users.entries()) await auto(tx, u.id, { autoPublishNextAt: ago(11 * MIN + i * H) });
      const ids = users.map((u) => u.id);

      const first = await recoverAutoPublishChains(tx, now, { userIds: ids, limit: 3 });
      expect(first).toEqual({ found: 3, restarted: 3, failed: [] });
      const started = async () => (await Promise.all(ids.map(async (id) => [id, (await live(tx, id)).length] as const))).filter(([, n]) => n > 0).map(([id]) => id);
      expect(new Set(await started())).toEqual(new Set([ids[4], ids[3], ids[2]]));

      const second = await recoverAutoPublishChains(tx, now, { userIds: ids, limit: 3 });
      expect(second).toEqual({ found: 2, restarted: 2, failed: [] });
      expect(await started()).toHaveLength(5);
      expect(await recoverAutoPublishChains(tx, now, { userIds: ids, limit: 3 })).toMatchObject({ found: 0 });
    });
    expect(RECOVER_BATCH).toBe(20); // the production cap
  });

  test("the lookup is one statement, plus one enqueue per user found", async () => {
    await inRolledBackTx(async ({ tx, makeUser }) => {
      const users = [await makeUser(), await makeUser(), await makeUser()];
      const ids = users.map((u) => u.id);
      expect((await countQueries(() => recoverAutoPublishChains(tx, now, { userIds: ids }))).queries).toBe(1); // nothing to do: one statement
      for (const u of users) await auto(tx, u.id);
      const busy = await countQueries(() => recoverAutoPublishChains(tx, now, { userIds: ids }));
      expect(busy.result.restarted).toBe(3);
      expect(busy.queries).toBe(1 + 3);
      expect((await countQueries(() => recoverAutoPublishChains(tx, now, { userIds: ids }))).queries).toBe(1); // and idle again
    });
  });

  test("one user's failing enqueue does not stop the others, and is reported", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const good = await makeUser();
      await auto(tx, user.id, { autoPublishNextAt: ago(5 * H) }); // first in line
      await auto(tx, good.id);
      const failing = new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === "insert") {
            return (table: unknown) => ({
              values: (v: { userId?: string }) => {
                if (v.userId === user.id) throw new Error("insert refused");
                return (value as (t: unknown) => { values: (x: unknown) => unknown }).call(target, table).values(v);
              },
            });
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as DbLike;

      const r = await recoverAutoPublishChains(failing, now, { userIds: [user.id, good.id] });
      expect(r.found).toBe(2);
      expect(r.restarted).toBe(1);
      expect(r.failed).toEqual([`${user.id}: insert refused`]);
      expect(await live(tx, good.id)).toHaveLength(1);
      expect(await live(tx, user.id)).toHaveLength(0);
    });
  });

  test("a scope is mandatory once given, and the limit must be a positive integer", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await expect(recoverAutoPublishChains(tx, now, { userIds: [] })).rejects.toThrow("non-empty");
      await expect(recoverAutoPublishChains(tx, now, { userIds: [""] })).rejects.toThrow("non-empty");
      await expect(recoverAutoPublishChains(tx, now, { userIds: [randomUUID()], limit: 0 })).rejects.toThrow("positive integer");
    });
  });
});

describe("a restarted chain is the same chain the user's Start button makes", () => {
  test("Start after a recovery replaces the recovered run instead of adding a second one; Stop ends it", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await auto(tx, user.id);
      await recoverAutoPublishChains(tx, now, { userIds: [user.id] });
      expect(await live(tx, user.id)).toHaveLength(1);

      const at = Date.now() + 2 * H;
      await callRpc("settings.startAutoPublish", { scheduledAt: at, intervalMs: 6 * H, count: 1, privacy: "public" }, { user, tx });
      const after = await live(tx, user.id);
      expect(after).toHaveLength(1);
      expect(after[0].runAt.getTime()).toBe(at);
      expect((await chain(tx, user.id)).filter((t) => t.status === "cancelled")).toHaveLength(1); // the recovered run

      await callRpc("settings.stopAutoPublish", {}, { user, tx });
      expect(await live(tx, user.id)).toHaveLength(0);
      expect(await recoverAutoPublishChains(tx, now, { userIds: [user.id] })).toMatchObject({ found: 0 }); // stopped: never recovered
    });
  });
});
