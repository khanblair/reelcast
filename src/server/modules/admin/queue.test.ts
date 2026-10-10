/**
 * admin.queue.getHealth (scaling ladder M-3, Q-3a): the admin view of the job runner.
 *
 * The gate itself (signed out -> UNAUTHENTICATED, non-admin -> FORBIDDEN, auth: "admin") is enforced for the whole
 * api.admin tree by admin.test.ts, which now also lists this function by name. These tests cover what it returns.
 * The database is shared with the live tick: rows are planted inside a rolled-back transaction, planted tasks are given
 * timestamps in the FUTURE so they are the newest whatever else is in the table, and nothing here touches `tick.heartbeat`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { tasks } from "@/db/schema";
import { countQueries, callRpc, inRolledBackTx } from "../../testing";
import type { UserRow } from "../../rpc/define";

setDefaultTimeout(120_000);

const asAdmin = (u: UserRow): UserRow => ({ ...u, isAdmin: true });

type Health = {
  queue: { jobs: Record<string, number>; tasks: Record<string, number>; oldestPendingAgeMs?: number };
  failedTasks: { _id: string; kind: string; attempts: number; maxAttempts: number; lastError?: string; failedAt: number }[];
  tick: { lastRunAt?: number; ageMs?: number; stale: boolean; lastError?: string };
  scheduleErrors: { name: string; lastRunAt?: number; lastError: string }[];
};

async function plantFailedTasks(tx: DbLike, userId: string, tag: string, n: number) {
  await tx.insert(tasks).values(
    Array.from({ length: n }, (_, i) => ({
      kind: `${tag}-${i}`,
      userId,
      status: "failed" as const,
      attempts: 3,
      maxAttempts: 3,
      updatedAt: sql`now() + ${i + 1} * interval '1 minute'`, // the newest of all, i = n-1 first
      payload: { secret: "LEAKSENTINEL_PAYLOAD" },
      lastError: i === 0 ? "Failed query: select 1 where email = $1\nparams: LEAKSENTINEL@example.com" : `boom ${i}`,
    })),
  );
}

describe("admin.queue.getHealth", () => {
  test("returns the queue depth, failed tasks, heartbeat and failing sweeps, over the wire format", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const tag = `test.admin-queue.${randomUUID()}`;
      await plantFailedTasks(tx, user.id, tag, 3);
      const sweep = `test-sweep-${randomUUID()}`;
      await tx.execute(sql`insert into job_schedules (name, last_run_at, last_error) values (${sweep}, now(), 'sweep exploded')`);

      const h = (await callRpc("admin.queue.getHealth", {}, { user: asAdmin(user), tx })) as Health;

      expect(Object.keys(h).sort()).toEqual(["failedTasks", "queue", "scheduleErrors", "tick"]);
      for (const c of [h.queue.jobs, h.queue.tasks]) {
        expect(Object.keys(c).sort()).toEqual(["failedLast24h", "pending", "processing", "scheduled"]); // oldest age is omitted when null
      }
      expect(h.queue.tasks.failedLast24h).toBeGreaterThanOrEqual(3); // ours (plus any real ones)
      expect(typeof h.tick.stale).toBe("boolean");

      const ours = h.failedTasks.filter((t) => t.kind.startsWith(tag));
      expect(ours.map((t) => t.kind)).toEqual([`${tag}-2`, `${tag}-1`, `${tag}-0`]); // newest first
      expect(ours[0]).toMatchObject({ attempts: 3, maxAttempts: 3, lastError: "boom 2" });
      expect(typeof ours[0].failedAt).toBe("number");
      expect(ours[2].lastError).toBe("Failed query: select 1 where email = $1");

      expect(h.scheduleErrors.find((e) => e.name === sweep)).toMatchObject({ lastError: "sweep exploded" });
      expect(h.scheduleErrors.map((e) => e.name)).not.toContain("tick.heartbeat");

      expect(JSON.stringify(h)).not.toContain("LEAKSENTINEL"); // neither the bound values nor the payload
    });
  });

  test("lists at most the 20 most recent failed tasks", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const tag = `test.admin-queue.${randomUUID()}`;
      await plantFailedTasks(tx, user.id, tag, 25);
      const h = (await callRpc("admin.queue.getHealth", {}, { user: asAdmin(user), tx })) as Health;
      expect(h.failedTasks).toHaveLength(20);
      // all 20 are ours (they are the newest): indices 24 down to 5
      expect(h.failedTasks.map((t) => t.kind)).toEqual(Array.from({ length: 20 }, (_, i) => `${tag}-${24 - i}`));
    });
  });

  test("costs 3 statements, and the number does not grow with the data", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const before = await countQueries(() => callRpc("admin.queue.getHealth", {}, { user: asAdmin(user), tx }));
      expect(before.queries).toBe(3);

      await plantFailedTasks(tx, user.id, `test.admin-queue.${randomUUID()}`, 40);
      for (let i = 0; i < 8; i++) await tx.execute(sql`insert into job_schedules (name, last_run_at, last_error) values (${`test-sweep-${randomUUID()}`}, now(), 'boom')`);
      const after = await countQueries(() => callRpc("admin.queue.getHealth", {}, { user: asAdmin(user), tx }));
      expect(after.queries).toBe(3);
      expect((after.result as Health).failedTasks).toHaveLength(20);
    });
  });

  test("a signed-out caller and a non-admin are refused", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("admin.queue.getHealth", {}, { user: null, tx })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(callRpc("admin.queue.getHealth", {}, { user: { ...user, isAdmin: false }, tx })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});
