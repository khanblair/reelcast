/**
 * Keeps postgres.js from ever sending a statement while another is still in flight on the same connection.
 *
 * Why this exists: when more statements are issued at once than there are connections (always the case with
 * `max: 1`, i.e. production, and with any `Promise.all` wider than the pool), postgres.js writes the extra statements
 * onto a connection that is still busy ("pipelining"). Through the Supabase transaction pooler that HANGS: measured
 * with the real admin functions, `admin.stats.getStats` and three other admin RPCs never returned with the production
 * settings. postgres.js has no safe switch for it (`max_pipeline: 0` also disables the hook that `sql.begin` needs to
 * reserve its connection, which breaks transactions), so the limit is enforced here, in front of the driver:
 *
 *  - at most `limit` (= the pool size) statements are in flight at once; the rest wait in a FIFO queue here
 *  - a transaction (`begin`) holds one of those slots for its whole duration
 *  - statements inside a transaction (and its savepoints) run one at a time, because they share one connection
 *
 * A statement is only released after the server has answered it, so the next one never overlaps it. `Promise.all`
 * still works exactly as written; it just runs as parallel as the pool allows and never wider.
 *
 * Only what Drizzle's postgres-js driver calls is wrapped: `unsafe(...)` (optionally `.values()`), `begin` and
 * `savepoint`. Everything else (options, end, ...) is passed straight through.
 */
import type postgres from "postgres";

type Sql = postgres.Sql;

/** A FIFO counting semaphore. */
export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Gate limit must be a positive integer");
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    // The slot is handed over directly (active stays the same), so a newcomer cannot jump the queue.
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  async run<T>(fn: () => PromiseLike<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

type PendingLike = PromiseLike<unknown> & { values?: () => PendingLike };

/**
 * What `sql.unsafe(...)` returns, made lazy and gated: nothing is sent until it is awaited, then it waits for a slot.
 * Supports the one method Drizzle chains onto it, `.values()`.
 */
function gatedQuery(gate: Gate, start: () => PendingLike): PromiseLike<unknown> & { values: () => unknown; execute: () => unknown; catch: PromiseLike<unknown>["then"]; finally: (f: () => void) => Promise<unknown> } {
  let wantValues = false;
  let promise: Promise<unknown> | undefined;
  const run = () =>
    (promise ??= gate.run(async () => {
      const q = start();
      return await (wantValues && q.values ? q.values() : q);
    }));
  const self = {
    values() {
      wantValues = true;
      return self;
    },
    execute() {
      void run().catch(() => {}); // start now; the error is delivered to whoever awaits it
      return self;
    },
    then: ((onFulfilled: never, onRejected: never) => run().then(onFulfilled, onRejected)) as PromiseLike<unknown>["then"],
    catch: ((onRejected: never) => run().then(undefined, onRejected)) as PromiseLike<unknown>["then"],
    finally: (onFinally: () => void) => run().finally(onFinally),
  };
  return self;
}

/** The callback is always the last argument: begin(cb), begin(options, cb), savepoint(cb), savepoint(name, cb). */
function splitCallback(args: unknown[]): { rest: unknown[]; callback: (sql: Sql) => unknown } {
  return { rest: args.slice(0, -1), callback: args[args.length - 1] as (sql: Sql) => unknown };
}

function wrap(target: Sql, gate: Gate, scope: "pool" | "transaction"): Sql {
  return new Proxy(target, {
    apply: (t, thisArg, args) => Reflect.apply(t, thisArg, args),
    get(t, prop) {
      if (prop === "unsafe") {
        return (...args: unknown[]) => gatedQuery(gate, () => (t.unsafe as (...a: unknown[]) => PendingLike)(...args));
      }
      if (prop === "begin") {
        const begin = (t as unknown as { begin: (...a: unknown[]) => Promise<unknown> }).begin.bind(t);
        return (...args: unknown[]) => {
          const { rest, callback } = splitCallback(args);
          // The transaction takes one pool slot for as long as it runs; its own statements are serialised on a new gate.
          return gate.run(() => begin(...rest, (tx: Sql) => callback(wrap(tx, new Gate(1), "transaction"))));
        };
      }
      if (prop === "savepoint" && scope === "transaction") {
        const savepoint = (t as unknown as { savepoint: (...a: unknown[]) => Promise<unknown> }).savepoint.bind(t);
        return (...args: unknown[]) => {
          const { rest, callback } = splitCallback(args);
          // Same connection, so the same gate: nothing may overlap a statement of the enclosing transaction.
          return savepoint(...rest, (sp: Sql) => callback(wrap(sp, gate, "transaction")));
        };
      }
      return Reflect.get(t, prop);
    },
  }) as Sql;
}

/** Wrap a postgres.js client so that no more than `limit` (the pool size) statements are ever in flight. */
export function limitConcurrency(client: Sql, limit: number): Sql {
  return wrap(client, new Gate(limit), "pool");
}
