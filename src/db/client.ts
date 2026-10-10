/**
 * Server-only Postgres client (Supabase transaction pooler).
 * Never import this from a client component. All access control happens in the
 * RPC layer (src/server/rpc), not in the database: the app connects as the
 * `postgres` role and the tables are closed to anon/authenticated.
 *
 * The connection is created on FIRST USE, not on import. `next build` imports every route to collect
 * page data, and a build must not need runtime secrets (a first preview deploy, CI, a fresh clone).
 * If DATABASE_URL is missing the error is thrown by the first query instead, with the same message.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { queryCountingLogger } from "./query-counter";
import * as schema from "./schema";

declare global {
  // Reuse the connection across hot reloads in dev.
  var __reelcastPg: ReturnType<typeof postgres> | undefined;
}

function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return postgres(url, {
    // Supabase transaction pooler does not support prepared statements.
    prepare: false,
    max: process.env.NODE_ENV === "production" ? 1 : 5,
    idle_timeout: 20,
    connect_timeout: 15,
  });
}

function createDb() {
  const client = globalThis.__reelcastPg ?? createClient();
  if (process.env.NODE_ENV !== "production") globalThis.__reelcastPg = client;
  return drizzle(client, { schema, casing: "snake_case", logger: queryCountingLogger });
}

type Drizzle = ReturnType<typeof createDb>;

let instance: Drizzle | undefined;
const getDb = (): Drizzle => (instance ??= createDb());

/**
 * The database handle. A thin proxy over the real Drizzle instance so that importing this module never
 * opens a connection; every property access (`db.select`, `db.transaction`, `db.execute`, ...) is forwarded.
 */
export const db: Drizzle = new Proxy({} as Drizzle, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
  has(_target, prop) {
    return Reflect.has(getDb(), prop);
  },
});

/** Root db handle. Transactions (`db.transaction(tx => ...)`) are assignable to `DbLike`. */
export type Db = Drizzle;
export type DbLike = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
