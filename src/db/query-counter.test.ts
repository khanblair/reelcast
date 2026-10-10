import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { countQueries, inRolledBackTx } from "@/server/testing";

describe("countQueries", () => {
  test("counts the statements run inside it, including inside a transaction, and nothing outside it", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await tx.execute(sql`select 1`); // before: not counted
      const { queries, statements } = await countQueries(async () => {
        await tx.execute(sql`select 2`);
        await tx.execute(sql`select 3`);
      });
      expect(queries).toBe(2);
      expect(statements.map((s) => s.trim())).toEqual(["select 2", "select 3"]);
      await tx.execute(sql`select 4`); // after: not counted
    });
  });

  test("counts parallel queries and keeps concurrent counters apart", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const [a, b] = await Promise.all([
        countQueries(() => Promise.all([tx.execute(sql`select 1`), tx.execute(sql`select 2`), tx.execute(sql`select 3`)])),
        countQueries(() => tx.execute(sql`select 4`)),
      ]);
      expect(a.queries).toBe(3);
      expect(b.queries).toBe(1);
    });
  });
});
