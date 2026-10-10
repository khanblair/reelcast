import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { youtubeQuotaUsage } from "@/db/schema";
import { createCommittedTestUser, deleteCommittedTestUsers, inRolledBackTx } from "@/server/testing";
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

  // Committed rows (separate connections), owned by a throwaway user that is deleted afterwards.
  beforeAll(async () => {
    userId = (await createCommittedTestUser()).id;
  });

  afterAll(async () => {
    await deleteCommittedTestUsers([userId]); // cascades its quota rows
  });

  test("20 parallel increments lose nothing and never create duplicate rows", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => addYoutubeQuota(db, userId, 3)));
    expect(await getYoutubeQuotaUsed(db, userId)).toBe(60);
    expect(new Set(results).size).toBe(20); // every caller saw a distinct running total
    const rows = await db
      .select()
      .from(youtubeQuotaUsage)
      .where(and(eq(youtubeQuotaUsage.userId, userId), eq(youtubeQuotaUsage.date, utcDateString())));
    expect(rows).toHaveLength(1);
  });
});
