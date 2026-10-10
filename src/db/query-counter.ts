/**
 * Counts the SQL statements a piece of code runs, so a test can prove "10 rows cost the same number of queries as 1 row"
 * (the N+1 regression guard). The Drizzle logger below is installed on the real client (src/db/client.ts); outside
 * countQueries() it does nothing but read an AsyncLocalStorage store, so it is free in production.
 *
 * Counts per async call chain, so parallel code (Promise.all) is counted correctly and two tests never see each other.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Store = { n: number; statements: string[] };
const als = new AsyncLocalStorage<Store>();

export const queryCountingLogger = {
  logQuery(query: string) {
    const store = als.getStore();
    if (!store) return;
    store.n++;
    store.statements.push(query);
  },
};

export async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number; statements: string[] }> {
  const store: Store = { n: 0, statements: [] };
  // Await INSIDE the store: Drizzle's query builders are lazy and only run when awaited, and the logger must see the store.
  const result = await als.run(store, async () => await fn());
  return { result, queries: store.n, statements: store.statements };
}
