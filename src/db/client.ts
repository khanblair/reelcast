/**
 * Server-only Postgres client (Supabase transaction pooler).
 * Never import this from a client component. All access control happens in the
 * RPC layer (src/server/rpc), not in the database: the app connects as the
 * `postgres` role and the tables are closed to anon/authenticated.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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

export const pg = globalThis.__reelcastPg ?? createClient();
if (process.env.NODE_ENV !== "production") globalThis.__reelcastPg = pg;

export const db = drizzle(pg, { schema, casing: "snake_case" });

/** Root db handle. Transactions (`db.transaction(tx => ...)`) are assignable to `DbLike`. */
export type Db = typeof db;
export type DbLike = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;
