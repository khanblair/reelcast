/**
 * Counts the SQL statements a piece of code runs, so a test can prove "10 rows cost the same number of queries as 1 row"
 * (the N+1 regression guard). The Drizzle logger below is installed on the real client (src/db/client.ts); outside
 * a counting scope it does nothing but read an AsyncLocalStorage store, so it is free. In production every RPC call
 * opens a counting scope (withQueryCount) so its log line can say how many statements it cost.
 *
 * Counts per async call chain, so parallel code (Promise.all) is counted correctly and two tests never see each other.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type Store = { n: number; statements: string[]; keep: boolean };
const als = new AsyncLocalStorage<Store>();

export const queryCountingLogger = {
  logQuery(query: string) {
    const store = als.getStore();
    if (!store) return;
    store.n++;
    if (store.keep) store.statements.push(query);
  },
};

export async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number; statements: string[] }> {
  const store: Store = { n: 0, statements: [], keep: true };
  // Await INSIDE the store: Drizzle's query builders are lazy and only run when awaited, and the logger must see the store.
  const result = await als.run(store, async () => await fn());
  return { result, queries: store.n, statements: store.statements };
}

/**
 * Run `fn` and report how many SQL statements it ran, for the always-on per-call log line (src/server/rpc/dispatch.ts).
 *
 * If a store is already active (a test's `countQueries` wrapped us) it is REUSED, never shadowed: the statements still land
 * in the outer counter and the outer test still sees them; this call's own count is the difference since it started.
 * With no active store (production) a throwaway one is created that only counts: it keeps no SQL text, so a request
 * does not hold on to its statements. `count()` can be read at any time, including after `fn` threw.
 */
export async function withQueryCount<T>(fn: (count: () => number) => Promise<T>): Promise<T> {
  const existing = als.getStore();
  if (existing) {
    const before = existing.n;
    return await fn(() => existing.n - before);
  }
  const store: Store = { n: 0, statements: [], keep: false };
  return await als.run(store, async () => await fn(() => store.n));
}
