/**
 * Test helpers. DB-touching tests run inside a transaction that is ALWAYS rolled back, so
 * nothing persists.
 *
 *   await inRolledBackTx(async ({ tx, user, makeUser }) => {
 *     const other = await makeUser();                        // a second user, for ownership tests
 *     const out = await callRpc("videos.list", {}, { user, tx });
 *   });
 *
 * Every call gets its OWN synthetic user (random uuid). The
 * users -> auth.users FK is deferred for the transaction (and never checked: we always roll back),
 * so no auth.users row is needed and we never create real auth accounts; everything else is real. Because users are no longer shared, parallel tests
 * (and parallel agents) never block each other on a row lock.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type DbLike } from "@/db/client";
import { users } from "@/db/schema";
import { dispatch } from "./rpc/dispatch";
import type { UserRow } from "./rpc/define";
import { api } from "./rpc/registry";

class Rollback extends Error {}

export type TxHarness = {
  tx: DbLike;
  /** The default synthetic user. */
  user: UserRow;
  /** Kept for older tests: same as user.id. */
  authUserId: string;
  /** Create another synthetic user inside the same transaction. */
  makeUser: (overrides?: Partial<typeof users.$inferInsert>) => Promise<UserRow>;
};

export async function inRolledBackTx<T>(fn: (h: TxHarness) => Promise<T>): Promise<T> {
  let result!: T;
  try {
    await db.transaction(async (tx) => {
      // The users -> auth.users FK is DEFERRABLE (migration 0006). Deferring it here means it would
      // only be checked at COMMIT, which never happens (we always roll back): no auth.users row is
      // needed, and every other trigger (cascades, other FKs, updates) behaves exactly as in prod.
      await tx.execute(sql`set constraints users_id_auth_fkey deferred`);
      const makeUser: TxHarness["makeUser"] = async (overrides = {}) => {
        const id = overrides.id ?? randomUUID();
        const [row] = await tx
          .insert(users)
          .values({ email: `test-${id}@example.test`, ...overrides, id })
          .returning();
        return row;
      };
      const user = await makeUser();
      result = await fn({ tx: tx as unknown as DbLike, user, authUserId: user.id, makeUser });
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return result;
}

/** Call an RPC function in-process (no HTTP, no cookies). `user: null` simulates a signed-out caller. */
export function callRpc(path: string, args: unknown, who: { user: UserRow | null; tx?: DbLike }, registry: object = api) {
  return dispatch({
    registry,
    path,
    args,
    req: new Request("http://localhost/api/rpc", { method: "POST" }),
    override: { user: who.user, db: who.tx },
  });
}

export { countQueries } from "@/db/query-counter";
