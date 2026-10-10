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
 *
 * The database may be the PRODUCTION one (dev and prod can share it), so a test acts only on rows it created:
 *  - rolled-back transactions (above) whenever possible;
 *  - `createCommittedTestUser` when real concurrency needs committed rows: a throwaway user, deleted in afterAll
 *    (everything hangs off it with ON DELETE CASCADE). Never pick an existing account;
 *  - `refuseUnscopedQueueSql` around the db handle that is passed to claimJobs / claimTasks / recoverStale / runTick,
 *    so a call that forgot `scope` throws instead of touching a real job.
 */
import { randomUUID } from "node:crypto";
import { inArray, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

// ─── committed rows ──────────────────────────────────────────────────────────

let swept: Promise<unknown> | undefined;

/**
 * A throwaway user committed to the database, for tests that need separate connections (SKIP LOCKED, racing
 * payments). It has no auth.users row (the FK is skipped for this insert only): nobody can sign in as it and no
 * auth identity is ever created. Delete it with `deleteCommittedTestUsers` in afterAll. A killed run leaves at most
 * these reserved `.invalid` addresses behind; the first call in each process removes the ones older than 30 minutes.
 */
export async function createCommittedTestUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<UserRow> {
  swept ??= (async () => void (await db.execute(sql`delete from users where email like 'committed-test-%@example.invalid' and created_at < now() - interval '30 minutes'`)))();
  await swept;
  const id = overrides.id ?? randomUUID();
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    const [row] = await tx
      .insert(users)
      .values({ email: `committed-test-${id}@example.invalid`, ...overrides, id })
      .returning();
    return row;
  });
}

/** Hard-delete users made by `createCommittedTestUser`; the cascade removes everything that hangs off them. */
export async function deleteCommittedTestUsers(ids: string[]): Promise<void> {
  if (ids.length) await db.delete(users).where(inArray(users.id, ids));
}

const pg = new PgDialect();

/**
 * Wraps a db handle so that a claim or recovery statement on jobs/tasks WITHOUT a `user_id = ...` filter throws
 * before it reaches the database. Pass the wrapped handle wherever the queue functions take a `db`.
 */
export function refuseUnscopedQueueSql<T extends DbLike>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      const value = Reflect.get(t, prop, t);
      if (prop !== "execute") return typeof value === "function" ? value.bind(t) : value;
      return (query: SQL | string) => {
        const text = (typeof query === "string" ? query : pg.sqlToQuery(query).sql).replace(/\s+/g, " ").toLowerCase();
        const touchesQueue = /\b(?:from|update)\s+(?:public\.)?"?(?:jobs|tasks)"?\s/.test(text);
        const claimsOrRecovers = /skip locked|locked_at\s*</.test(text);
        if (touchesQueue && claimsOrRecovers && !/user_id\s*=/.test(text)) throw new Error(`refused an unscoped queue statement: ${text.slice(0, 140)}`);
        return (value as (q: SQL | string) => unknown).call(t, query);
      };
    },
  });
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
