/**
 * The test helpers that keep DB tests off real data (the database may be the production one).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db, type DbLike } from "@/db/client";
import { tasks, users } from "@/db/schema";
import { claimJobs, claimTasks, recoverStale } from "./jobs/queue";
import { createCommittedTestUser, deleteCommittedTestUsers, refuseUnscopedQueueSql } from "./testing";

setDefaultTimeout(60_000);

describe("refuseUnscopedQueueSql", () => {
  /** A db that records what reaches it and answers like an idle queue. */
  function fakeDb() {
    const seen: string[] = [];
    const target = { marker: 7, execute: async (q: unknown) => (seen.push(typeof q === "string" ? q : "sql"), [{ jobs: false, tasks: false }]) };
    return { seen, guarded: refuseUnscopedQueueSql(target as unknown as DbLike) };
  }
  const refused = "refused an unscoped queue statement";

  test("lets scoped claims and recovery through", async () => {
    const { guarded, seen } = fakeDb();
    await claimJobs(guarded, 1, undefined, { userId: "u1" });
    await claimTasks(guarded, 1, ["k"], { userId: "u1" });
    await recoverStale(guarded, 1, { userId: "u1" });
    expect(seen).toHaveLength(3);
  });

  test("throws on a claim or recovery without a scope, before it reaches the database", async () => {
    const { guarded, seen } = fakeDb();
    await expect(claimJobs(guarded, 1, ["publish"])).rejects.toThrow(refused);
    await expect(claimTasks(guarded, 1)).rejects.toThrow(refused);
    await expect(recoverStale(guarded, 1)).rejects.toThrow(refused);
    expect(seen).toEqual([]);
  });

  test("leaves every other statement and property alone", async () => {
    const { guarded, seen } = fakeDb();
    await guarded.execute(sql`select 1`);
    await guarded.execute(sql`update job_schedules set lease_until = null where name = ${"x"}`);
    await guarded.execute(sql`select id from videos where status = 'pending'`);
    expect(seen).toHaveLength(3);
    expect((guarded as unknown as { marker: number }).marker).toBe(7);
  });
});

describe("createCommittedTestUser", () => {
  test("makes a throwaway user with no auth identity, and deleting it removes what hangs off it", async () => {
    const user = await createCommittedTestUser({ plan: "pro" });
    try {
      expect(user.email).toMatch(/^committed-test-.+@example\.invalid$/);
      expect(user.plan).toBe("pro");
      const [{ n }] = (await db.execute(sql`select count(*)::int as n from auth.users where id = ${user.id}`)) as unknown as { n: number }[];
      expect(n).toBe(0); // read-only check: no sign-in identity exists for it
      await db.insert(tasks).values({ kind: "__testing_probe", userId: user.id, status: "done" });
    } finally {
      await deleteCommittedTestUsers([user.id]);
    }
    expect(await db.select().from(users).where(eq(users.id, user.id))).toEqual([]);
    expect(await db.select().from(tasks).where(eq(tasks.userId, user.id))).toEqual([]); // cascaded
  });
});

describe("no test touches an existing account", () => {
  test("no test file selects a row from auth.users (tests create their own users)", () => {
    const offenders = (readdirSync("src", { recursive: true }) as string[])
      .filter((f) => /\.test\.tsx?$/.test(f) && !f.endsWith("testing.test.ts"))
      .filter((f) => /from\s+auth\.users/i.test(readFileSync(`src/${f}`, "utf8")));
    expect(offenders).toEqual([]);
  });
});
