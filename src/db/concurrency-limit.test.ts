import { describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { Gate, limitConcurrency } from "./concurrency-limit";

/** A stand-in for postgres.js that records how many statements are in flight, per connection scope. */
function fakeClient(delayMs = 5) {
  const log = { started: [] as string[], inFlight: 0, maxInFlight: 0, txStatements: [] as { tx: number; inFlightInTx: number }[], txDepth: 0 };
  let txCounter = 0;

  const statement = (state: { inFlight: number }, text: string, fail = false) => {
    let promise: Promise<unknown> | undefined;
    const run = (values: boolean) =>
      (promise ??= new Promise((resolve, reject) => {
        log.started.push(text);
        log.inFlight++;
        state.inFlight++;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        setTimeout(() => {
          log.inFlight--;
          state.inFlight--;
          if (fail) reject(new Error(`boom: ${text}`));
          else resolve(values ? [[text]] : [{ text }]);
        }, delayMs);
      }));
    const q = {
      values: () => ({ then: (a: never, b: never) => run(true).then(a, b) }),
      then: (a: never, b: never) => run(false).then(a, b),
    };
    return q;
  };

  const makeSql = (state: { inFlight: number; id: number }, onTxStatement?: () => void) => {
    const sql = (() => {}) as unknown as Record<string, unknown>;
    sql.options = { parsers: {}, serializers: {} };
    sql.unsafe = (text: string) => {
      onTxStatement?.();
      return statement(state, text, text.startsWith("fail"));
    };
    sql.begin = async (...args: unknown[]) => {
      const cb = args[args.length - 1] as (tx: unknown) => Promise<unknown>;
      const txState = { inFlight: 0, id: ++txCounter };
      return await cb(makeSql(txState, () => log.txStatements.push({ tx: txState.id, inFlightInTx: txState.inFlight })));
    };
    sql.savepoint = async (...args: unknown[]) => {
      const cb = args[args.length - 1] as (sp: unknown) => Promise<unknown>;
      return await cb(makeSql(state, () => log.txStatements.push({ tx: state.id, inFlightInTx: state.inFlight })));
    };
    return sql as unknown as postgres.Sql;
  };

  return { sql: makeSql({ inFlight: 0, id: 0 }), log };
}

describe("Gate", () => {
  test("rejects a bad limit", () => {
    expect(() => new Gate(0)).toThrow();
    expect(() => new Gate(1.5)).toThrow();
  });
});

describe("limitConcurrency: statements", () => {
  test("never has more statements in flight than the limit, and runs them in the order they were issued", async () => {
    const { sql, log } = fakeClient();
    const gated = limitConcurrency(sql, 3);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => gated.unsafe(`q${i}`) as unknown as Promise<unknown>));
    expect(log.maxInFlight).toBe(3);
    expect(log.started).toEqual(Array.from({ length: 10 }, (_, i) => `q${i}`));
    expect(results.map((r) => (r as { text: string }[])[0].text)).toEqual(Array.from({ length: 10 }, (_, i) => `q${i}`));
  });

  test("with a limit of 1 (production) everything is strictly one after another", async () => {
    const { sql, log } = fakeClient();
    const gated = limitConcurrency(sql, 1);
    await Promise.all(["a", "b", "c", "d"].map((t) => gated.unsafe(t) as unknown as Promise<unknown>));
    expect(log.maxInFlight).toBe(1);
  });

  test(".values() reaches the driver's .values()", async () => {
    const { sql } = fakeClient();
    const gated = limitConcurrency(sql, 2);
    expect(await (gated.unsafe("v").values() as unknown as Promise<unknown>)).toEqual([["v"]]);
    expect(await (gated.unsafe("v") as unknown as Promise<unknown>)).toEqual([{ text: "v" }]);
  });

  test("nothing is sent until the query is awaited, and awaiting twice sends it once", async () => {
    const { sql, log } = fakeClient();
    const gated = limitConcurrency(sql, 2);
    const q = gated.unsafe("lazy") as unknown as Promise<unknown>;
    await new Promise((r) => setTimeout(r, 15));
    expect(log.started).toEqual([]);
    await q;
    await q;
    expect(log.started).toEqual(["lazy"]);
  });

  test("a failed statement frees its slot, and the failure reaches only its own caller", async () => {
    const { sql, log } = fakeClient();
    const gated = limitConcurrency(sql, 1);
    const [a, b, c] = await Promise.allSettled([gated.unsafe("ok1"), gated.unsafe("fail-me"), gated.unsafe("ok2")] as unknown as Promise<unknown>[]);
    expect([a.status, b.status, c.status]).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect((b as PromiseRejectedResult).reason.message).toBe("boom: fail-me");
    expect(log.started).toEqual(["ok1", "fail-me", "ok2"]);
  });

  test("everything else on the client passes straight through", () => {
    const { sql } = fakeClient();
    const gated = limitConcurrency(sql, 2);
    expect((gated as unknown as { options: unknown }).options).toEqual({ parsers: {}, serializers: {} });
  });
});

describe("limitConcurrency: transactions", () => {
  test("statements issued together inside a transaction run one at a time", async () => {
    const { sql, log } = fakeClient();
    const gated = limitConcurrency(sql, 5);
    const out = await gated.begin(async (tx) => {
      await Promise.all([tx.unsafe("t1"), tx.unsafe("t2"), tx.unsafe("t3"), tx.unsafe("t4")] as unknown as Promise<unknown>[]);
      return "done";
    });
    expect(out).toBe("done");
    expect(log.started).toEqual(["t1", "t2", "t3", "t4"]);
    expect(log.maxInFlight).toBe(1);
  });

  test("a transaction holds a pool slot for its whole duration", async () => {
    const { sql, log } = fakeClient(10);
    const gated = limitConcurrency(sql, 1);
    const events: string[] = [];
    const tx = gated.begin(async (t) => {
      events.push("tx start");
      await t.unsafe("inside-1");
      await new Promise((r) => setTimeout(r, 20));
      await t.unsafe("inside-2");
      events.push("tx end");
    });
    const outside = (gated.unsafe("outside") as unknown as Promise<unknown>).then(() => events.push("outside ran"));
    await Promise.all([tx, outside]);
    expect(events).toEqual(["tx start", "tx end", "outside ran"]); // the outside statement waited for the whole transaction
    expect(log.started).toEqual(["inside-1", "inside-2", "outside"]);
  });

  test("two transactions with a limit of 2 run side by side, each serial inside", async () => {
    const { sql, log } = fakeClient();
    const gated = limitConcurrency(sql, 2);
    const body = (name: string) => async (tx: postgres.TransactionSql) => {
      await Promise.all([tx.unsafe(`${name}1`), tx.unsafe(`${name}2`)] as unknown as Promise<unknown>[]);
    };
    await Promise.all([gated.begin(body("a")), gated.begin(body("b"))]);
    expect(log.maxInFlight).toBe(2); // one statement per transaction
    expect(log.txStatements.every((s) => s.inFlightInTx === 0)).toBe(true); // never two in one transaction
  });

  test("begin(options, callback) and a failing callback both work, and release the slot", async () => {
    const { sql } = fakeClient();
    const gated = limitConcurrency(sql, 1);
    expect(await gated.begin("read only", async () => 42)).toBe(42);
    await expect(gated.begin(async () => { throw new Error("rolled back"); })).rejects.toThrow("rolled back");
    expect(await (gated.unsafe("still works") as unknown as Promise<unknown>)).toEqual([{ text: "still works" }]);
  });

  test("savepoints share the transaction's gate, so nothing overlaps on the one connection", async () => {
    const { sql, log } = fakeClient();
    const gated = limitConcurrency(sql, 3);
    await gated.begin(async (tx) => {
      const outer = tx.unsafe("outer");
      const inner = tx.savepoint(async (sp) => {
        await Promise.all([sp.unsafe("sp1"), sp.unsafe("sp2")] as unknown as Promise<unknown>[]);
      });
      await Promise.all([outer, inner] as unknown as Promise<unknown>[]);
    });
    expect(log.maxInFlight).toBe(1);
    expect(log.started.sort()).toEqual(["outer", "sp1", "sp2"]);
  });
});
