import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { users, youtubeQuotaUsage } from "@/db/schema";
import { inRolledBackTx } from "@/server/testing";
import { addYoutubeQuota, getYoutubeQuotaUsed, utcDateString } from "./youtubeQuota";

setDefaultTimeout(90_000);

describe("youtubeQuota", () => {
  test("utcDateString is the UTC calendar day", () => {
    expect(utcDateString(new Date("2026-03-04T23:59:59Z"))).toBe("2026-03-04");
    expect(utcDateString(new Date("2026-03-05T00:00:00Z"))).toBe("2026-03-05");
  });

  test("add returns the running total; non-positive units are a no-op", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const base = await getYoutubeQuotaUsed(tx, user.id);
      expect(await addYoutubeQuota(tx, user.id, 5)).toBe(base + 5);
      expect(await addYoutubeQuota(tx, user.id, 100)).toBe(base + 105);
      expect(await addYoutubeQuota(tx, user.id, 0)).toBe(base + 105);
      expect(await addYoutubeQuota(tx, user.id, -3)).toBe(base + 105);
      expect(await addYoutubeQuota(tx, user.id, Number.NaN)).toBe(base + 105);
      expect(await getYoutubeQuotaUsed(tx, user.id)).toBe(base + 105);
      expect(await getYoutubeQuotaUsed(tx, user.id, "1999-01-01")).toBe(0);
    });
  });
});

describe("youtubeQuota under real concurrency", () => {
  let userId = "";
  let createdUser = false;
  let before = 0;
  let hadRow = false;

  beforeAll(async () => {
    const rows = (await db.execute(sql`select id, email from auth.users order by created_at limit 1`)) as unknown as { id: string; email: string }[];
    userId = rows[0].id;
    if (!(await db.select().from(users).where(eq(users.id, userId)))[0]) {
      await db.insert(users).values({ id: userId, email: rows[0].email });
      createdUser = true;
    }
    const existing = await db
      .select()
      .from(youtubeQuotaUsage)
      .where(and(eq(youtubeQuotaUsage.userId, userId), eq(youtubeQuotaUsage.date, utcDateString())));
    hadRow = existing.length > 0;
    before = existing[0]?.unitsUsed ?? 0;
  });

  afterAll(async () => {
    // Undo exactly what the test added.
    if (hadRow) {
      await db
        .update(youtubeQuotaUsage)
        .set({ unitsUsed: before })
        .where(and(eq(youtubeQuotaUsage.userId, userId), eq(youtubeQuotaUsage.date, utcDateString())));
    } else {
      await db.delete(youtubeQuotaUsage).where(and(eq(youtubeQuotaUsage.userId, userId), eq(youtubeQuotaUsage.date, utcDateString())));
    }
    if (createdUser) await db.delete(users).where(eq(users.id, userId));
  });

  test("20 parallel increments lose nothing and never create duplicate rows", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => addYoutubeQuota(db, userId, 3)));
    expect(await getYoutubeQuotaUsed(db, userId)).toBe(before + 60);
    expect(new Set(results).size).toBe(20); // every caller saw a distinct running total
    const rows = await db
      .select()
      .from(youtubeQuotaUsage)
      .where(and(eq(youtubeQuotaUsage.userId, userId), eq(youtubeQuotaUsage.date, utcDateString())));
    expect(rows).toHaveLength(1);
  });
});
