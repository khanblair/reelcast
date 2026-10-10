import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { withQueryCount } from "@/db/query-counter";
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

describe("withQueryCount (the always-on counter behind the rpc log line)", () => {
  test("with no active counter it opens its own and counts only its own statements", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await tx.execute(sql`select 0`); // before: not counted
      let seen = -1;
      await withQueryCount(async (count) => {
        await tx.execute(sql`select 1`);
        await tx.execute(sql`select 2`);
        seen = count();
      });
      expect(seen).toBe(2);
    });
  });

  test("an active countQueries() is reused: its totals still include everything, and count() is relative to the start of the call", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const per: number[] = [];
      const { queries, statements } = await countQueries(async () => {
        await tx.execute(sql`select 1`); // before the first call
        for (const n of [2, 3]) {
          await withQueryCount(async (count) => {
            for (let i = 0; i < n; i++) await tx.execute(sql`select 1`);
            per.push(count());
          });
        }
      });
      expect(per).toEqual([2, 3]);
      expect(queries).toBe(6); // 1 + 2 + 3: the inner call did not hide anything from the outer counter
      expect(statements).toHaveLength(6);
    });
  });

  test("count() is readable after the callback threw", async () => {
    await inRolledBackTx(async ({ tx }) => {
      let after = -1;
      await withQueryCount(async (count) => {
        try {
          await tx.execute(sql`select 1`);
          throw new Error("late");
        } catch {
          after = count();
        }
      });
      expect(after).toBe(1);
    });
  });
});
