/**
 * Test helpers for outbound-call timeouts (imported by *.test.ts only; no database, no real network).
 *
 * `startFakeServer` listens on 127.0.0.1. A handler that returns `never()` accepts the connection and
 * never answers, which is how a hung upstream looks to the caller. `settle` races a call against a short
 * sentinel so a call WITHOUT a working timeout reports "pending" quickly instead of hanging the suite.
 */

export type Hit = { method: string; path: string; headers: Headers; body: string };
export type FakeServer = { url: string; hits: Hit[]; stop: () => void };

export function startFakeServer(handler: (hit: Hit, req: Request) => Response | Promise<Response>): FakeServer {
  const hits: Hit[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0, // the server must not be the one that ends a hung request
    async fetch(req) {
      const hit: Hit = { method: req.method, path: new URL(req.url).pathname, headers: req.headers, body: await req.text() };
      hits.push(hit);
      return handler(hit, req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => void server.stop(true) };
}

/** A response that never comes. */
export const never = (): Promise<Response> => new Promise<Response>(() => {});

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

export type Settled<T> =
  | { state: "pending"; elapsedMs: number }
  | { state: "resolved"; value: T; elapsedMs: number }
  | { state: "rejected"; error: unknown; elapsedMs: number };

/** Outcome of `call` within `guardMs`; "pending" means the call is still hanging (no usable timeout). */
export async function settle<T>(call: () => Promise<T>, guardMs: number): Promise<Settled<T>> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<{ state: "pending"; elapsedMs: number }>((resolve) => {
    timer = setTimeout(() => resolve({ state: "pending", elapsedMs: Date.now() - t0 }), guardMs);
  });
  const outcome = call().then(
    (value): Settled<T> => ({ state: "resolved", value, elapsedMs: Date.now() - t0 }),
    (error): Settled<T> => ({ state: "rejected", error, elapsedMs: Date.now() - t0 }),
  );
  try {
    return await Promise.race([outcome, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** Set env vars for a test and return a restore function. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
