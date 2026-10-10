/** No database, no real network: fetchWithTimeout against a fake server on 127.0.0.1. */
import { afterEach, describe, expect, test } from "bun:test";
import { jsonResponse, never, settle, startFakeServer, type FakeServer } from "@/lib/testing/fakeServer";
import { SUPABASE_AUTH_TIMEOUT_MS, fetchWithTimeout } from "./fetch";

/** A call without a working timeout is still pending after this long. */
const GUARD_MS = 2_500;
let server: FakeServer | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});

describe("fetchWithTimeout", () => {
  test("a request that is never answered rejects with a TimeoutError once the deadline passes", async () => {
    server = startFakeServer(never);
    const out = await settle(() => fetchWithTimeout(300)(`${server!.url}/auth/v1/user`), GUARD_MS);

    expect(server.hits.length).toBe(1);
    expect(out.state).toBe("rejected");
    if (out.state !== "rejected") return;
    expect(out.elapsedMs).toBeGreaterThanOrEqual(250);
    expect(out.elapsedMs).toBeLessThan(GUARD_MS);
    expect((out.error as Error).name).toBe("TimeoutError");
  });

  test("a body that stalls after the headers is cut off too", async () => {
    server = startFakeServer(() => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")) }), { headers: { "content-type": "application/json" } }));
    const out = await settle(async () => (await fetchWithTimeout(300)(`${server!.url}/x`)).text(), GUARD_MS);

    expect(out.state).toBe("rejected");
    expect(out.elapsedMs).toBeLessThan(GUARD_MS);
  });

  test("a fast response passes through untouched, with method, headers and body", async () => {
    server = startFakeServer((hit) => jsonResponse({ echoed: hit.body, auth: hit.headers.get("authorization") }));
    const res = await fetchWithTimeout()(`${server.url}/token`, { method: "POST", headers: { authorization: "Bearer t" }, body: "payload" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: "payload", auth: "Bearer t" });
    expect(server.hits[0].method).toBe("POST");
  });

  test("a caller's own AbortSignal is still honoured (and a Request's, when init has none)", async () => {
    server = startFakeServer(never);
    const own = new AbortController();
    const viaInit = settle(() => fetchWithTimeout(10_000)(`${server!.url}/a`, { signal: own.signal }), GUARD_MS);
    const viaRequest = settle(() => fetchWithTimeout(10_000)(new Request(`${server!.url}/b`, { signal: own.signal })), GUARD_MS);
    await Bun.sleep(100);
    own.abort();
    const [a, b] = await Promise.all([viaInit, viaRequest]);

    for (const out of [a, b]) {
      expect(out.state).toBe("rejected");
      expect(out.elapsedMs).toBeLessThan(GUARD_MS);
      expect((out as { error: Error }).error.name).toBe("AbortError"); // the caller's abort, not the 10 s timeout
    }
  });

  test("the default deadline is 10 s", () => {
    expect(SUPABASE_AUTH_TIMEOUT_MS).toBe(10_000);
  });
});
