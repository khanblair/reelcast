/**
 * Against the REAL Supabase pooler, with the real production connection options. Before the concurrency gate these
 * hung: concurrent statements on the single production connection never came back (and neither did the real
 * admin RPCs). If one of these starts timing out, the pooler is being pipelined again.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { count, eq, gte, sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { limitConcurrency } from "./concurrency-limit";
import { postgresOptions } from "./client";
import * as schema from "./schema";
import { jobs, users, videos } from "./schema";

setDefaultTimeout(120_000);
const url = process.env.DATABASE_URL;
const HANG_AFTER_MS = 30_000;

async function withDb<T>(poolMax: number | undefined, fn: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>) {
  const options = postgresOptions("production", poolMax ? String(poolMax) : undefined);
  const client = limitConcurrency(postgres(url!, options), options.max);
  const db = drizzle(client, { schema, casing: "snake_case" });
  try {
    return await fn(db);
  } finally {
    await client.end({ timeout: 0 }).catch(() => {});
  }
}

/** Resolves to "done", or "hung" if the work has not finished after HANG_AFTER_MS. */
const outcome = (work: Promise<unknown>) => Promise.race([work.then(() => "done"), new Promise<string>((r) => setTimeout(() => r("hung"), HANG_AFTER_MS))]);

describe.skipIf(!url)("production connection settings against the pooler", () => {
  test("options: one connection by default in production, configurable, a small pool elsewhere", () => {
    expect(postgresOptions("production", undefined)).toMatchObject({ max: 1, prepare: false });
    expect(postgresOptions("production", "3")).toMatchObject({ max: 3 });
    expect(postgresOptions("production", "0")).toMatchObject({ max: 1 }); // nonsense falls back to the default
    expect(postgresOptions("production", "abc")).toMatchObject({ max: 1 });
    expect(postgresOptions("development", undefined)).toMatchObject({ max: 5 });
  });

  for (const poolMax of [undefined, 3]) {
    const label = `pool of ${poolMax ?? 1}`;

    test(`${label}: a getStats-shaped Promise.all (a parameterless query first, then parameterised ones) completes`, async () => {
      await withDb(poolMax, async (db) => {
        for (let round = 0; round < 2; round++) {
          const work = Promise.all([
            db.select({ total: count() }).from(users),
            db.select({ n: count() }).from(videos).where(eq(videos.status, "published")),
            db.select({ n: count() }).from(jobs).where(gte(jobs.createdAt, new Date(0))),
            db.select({ n: dsql<number>`count(*) filter (where ${users.isAdmin})`.mapWith(Number) }).from(users),
            db.select({ n: count() }).from(jobs),
            db.select({ n: count() }).from(videos).where(gte(videos.createdAt, new Date(0))),
          ]);
          expect(await outcome(work)).toBe("done");
        }
      });
    });

    test(`${label}: concurrent statements inside a transaction complete`, async () => {
      await withDb(poolMax, async (db) => {
        const work = db.transaction(async (tx) => {
          await Promise.all([tx.select({ n: count() }).from(users), tx.select({ n: count() }).from(jobs), tx.select({ n: count() }).from(videos).where(eq(videos.status, "draft"))]);
          return "committed";
        });
        expect(await outcome(work)).toBe("done");
      });
    });

    test(`${label}: 20 statements issued at once, with transactions in between, all complete`, async () => {
      await withDb(poolMax, async (db) => {
        const work = Promise.all([
          ...Array.from({ length: 10 }, () => db.select({ n: count() }).from(users)),
          db.transaction(async (tx) => tx.select({ n: count() }).from(jobs)),
          ...Array.from({ length: 8 }, () => db.select({ n: count() }).from(videos).where(gte(videos.createdAt, new Date(0)))),
          db.transaction(async (tx) => Promise.all([tx.select({ n: count() }).from(users), tx.select({ n: count() }).from(jobs)])),
        ]);
        expect(await outcome(work)).toBe("done");
      });
    });
  }
});
