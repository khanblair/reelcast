/**
 * Fault injection for DB-backed tests (imported by *.test.ts only, never by app code).
 *
 * `failOn(db, "update", users)` returns a handle that behaves exactly like `db`, except that every
 * `update(users)` it (or any transaction opened from it) is asked to run throws instead. A test uses
 * it to simulate "the process died / the statement failed right here" at one precise point of a
 * multi-statement operation, then looks at what was left behind.
 *
 * It wraps the handle the code under test already receives, so no seam is needed in production code,
 * and it works on the rolled-back test transaction: a `db.transaction()` opened on the wrapper is a
 * real savepoint, so a thrown fault rolls that savepoint back exactly as it would roll back a real
 * transaction, while the outer test transaction stays usable for the follow-up assertions.
 */
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { DbLike } from "@/db/client";

export type FaultOp = "insert" | "update" | "delete";

export class InjectedFault extends Error {
  constructor(op: FaultOp, table: string) {
    super(`injected fault: ${op} ${table}`);
    this.name = "InjectedFault";
  }
}

type Fn = (...args: unknown[]) => unknown;

export function failOn(db: DbLike, op: FaultOp, table: PgTable): DbLike {
  const wrap = (target: DbLike): DbLike =>
    new Proxy(target, {
      get(t, prop) {
        if (prop === op) {
          return (...args: unknown[]) => {
            if (args[0] === table) throw new InjectedFault(op, getTableName(table));
            return (t[op] as unknown as Fn).apply(t, args);
          };
        }
        if (prop === "transaction") {
          return (cb: (tx: DbLike) => Promise<unknown>, config?: unknown) =>
            (t.transaction as unknown as Fn).call(t, (inner: DbLike) => cb(wrap(inner)), config);
        }
        const value = Reflect.get(t, prop, t);
        return typeof value === "function" ? (value as Fn).bind(t) : value;
      },
    });
  return wrap(db);
}
