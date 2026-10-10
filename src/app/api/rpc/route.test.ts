/**
 * POST /api/rpc request hardening (scaling ladder R-5), tested through the real route handler.
 *
 * Only `dispatch` is faked (it records what it is asked to run and answers `{ echo }`), so nothing here touches a session
 * or the database. Every refusal must happen BEFORE dispatch, must leave exactly one `rpc` warn line, and must never
 * read the body when a header already condemns the request.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { setRpcLogging } from "@/server/rpc/log";

type DispatchModule = typeof import("@/server/rpc/dispatch");
let realDispatch: DispatchModule;
let POST: (req: Request) => Promise<Response>;
const dispatched: { path: string; args: unknown }[] = [];

beforeAll(async () => {
  realDispatch = await import("@/server/rpc/dispatch");
  mock.module("@/server/rpc/dispatch", () => ({
    ...realDispatch,
    dispatch: async ({ path, args }: { path: string; args: unknown }) => {
      dispatched.push({ path, args });
      return { echo: path };
    },
  }));
  ({ POST } = await import("./route"));
});

afterAll(() => {
  // mock.module is process-wide: put the real module back for any test file that runs after this one.
  mock.module("@/server/rpc/dispatch", () => realDispatch);
});

const MAX = 1024 * 1024;
const URL_ = "https://app.test/api/rpc";
const JSON_CT = { "content-type": "application/json" };

let warn: ReturnType<typeof spyOn>;
let previousLogging: boolean;
let previousAppUrl: string | undefined;
const lines = () => warn.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])) as Record<string, unknown>);
/** Start a fresh observation inside one test (after a call that was supposed to succeed). */
const forgetCalls = () => {
  dispatched.length = 0;
  warn.mockClear();
};

beforeEach(() => {
  dispatched.length = 0;
  previousLogging = setRpcLogging(true);
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
  previousAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});
afterEach(() => {
  warn.mockRestore();
  setRpcLogging(previousLogging);
  if (previousAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = previousAppUrl;
});

const call = (init: { url?: string; headers?: Record<string, string>; body?: BodyInit | null } = {}) =>
  POST(new Request(init.url ?? URL_, { method: "POST", headers: { ...JSON_CT, ...init.headers }, body: init.body === undefined ? '{"path":"videos.list"}' : init.body }));

/** A request body that records how much was read from it and whether the reader gave up. */
function countingStream(totalBytes: number, chunkBytes = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= totalBytes) return controller.close();
        const n = Math.min(chunkBytes, totalBytes - state.pulled);
        state.pulled += n;
        controller.enqueue(new Uint8Array(n).fill(0x20)); // spaces: harmless JSON whitespace
      },
      cancel() {
        state.cancelled = true;
      },
    },
    // Nothing is produced until a reader asks for it, so `pulled` measures what the route actually read.
    { highWaterMark: 0 },
  );
  return { state, body };
}
const streamRequest = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  POST(new Request(URL_, { method: "POST", headers: { ...JSON_CT, ...headers }, body, duplex: "half" } as RequestInit));

/** A JSON body of EXACTLY `bytes` bytes (ASCII padding inside a string argument). */
function jsonOfSize(bytes: number): string {
  const head = '{"path":"videos.list","args":{"pad":"';
  const tail = '"}}';
  return head + "x".repeat(bytes - head.length - tail.length) + tail;
}

const expectRefused = async (res: Response, status: number, code: string) => {
  expect(res.status).toBe(status);
  expect(((await res.json()) as { ok: boolean; error: { code: string } })).toMatchObject({ ok: false, error: { code } });
  const l = lines();
  expect(l).toHaveLength(1);
  expect(l[0]).toMatchObject({ evt: "rpc", path: "(none)", ok: false, code, stmts: 0, uid: null });
  expect(dispatched).toEqual([]);
};

describe("a normal call", () => {
  test("is dispatched with its path and args and answered 200 with no-store", async () => {
    const res = await call({ body: JSON.stringify({ path: "videos.get", args: { id: "x" } }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, data: { echo: "videos.get" } });
    expect(dispatched).toEqual([{ path: "videos.get", args: { id: "x" } }]);
    expect(lines()).toEqual([]);
  });

  test("a charset parameter, no Origin header and same-origin Sec-Fetch-Site are all fine", async () => {
    const res = await call({ headers: { "content-type": "application/json; charset=utf-8", "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
  });
});

// The five refusals that already existed keep their log line (the old route returned 400 for every wrong content type; it is 415 now).
describe("refusals that already existed keep their status, code and one warn line", () => {
  const cases: [string, Parameters<typeof call>[0], number, string][] = [
    ["cross-site", { headers: { "sec-fetch-site": "cross-site" } }, 403, "FORBIDDEN"],
    ["same-site", { headers: { "sec-fetch-site": "same-site" } }, 403, "FORBIDDEN"],
    ["invalid JSON", { body: "{nope" }, 400, "BAD_REQUEST"],
    ["JSON null", { body: "null" }, 400, "BAD_REQUEST"],
    ["missing path", { body: JSON.stringify({ args: { a: 1 } }) }, 400, "BAD_REQUEST"],
    ["non-string path", { body: JSON.stringify({ path: 5 }) }, 400, "BAD_REQUEST"],
    ["empty body", { body: null }, 400, "BAD_REQUEST"],
    ["empty string body", { body: "" }, 400, "BAD_REQUEST"],
  ];
  for (const [what, init, status, code] of cases) {
    test(`${what}: ${status} ${code}`, async () => expectRefused(await call(init), status, code));
  }

  test("a wrong content type is refused as 415", async () => {
    await expectRefused(await call({ headers: { "content-type": "text/plain" } }), 415, "UNSUPPORTED_MEDIA_TYPE");
  });
});

describe("body size cap (1 MiB)", () => {
  test("a Content-Length over the cap is refused 413 without reading the body", async () => {
    const { state, body } = countingStream(10 * 1024 * 1024);
    const res = await streamRequest(body, { "content-length": String(MAX + 1) });
    await expectRefused(res, 413, "PAYLOAD_TOO_LARGE");
    expect(state.pulled).toBe(0);
  });

  test("a huge Content-Length is refused too", async () => {
    await expectRefused(await call({ headers: { "content-length": "99999999999999" } }), 413, "PAYLOAD_TOO_LARGE");
  });

  test("a body that is exactly the cap is accepted, one byte more is refused", async () => {
    expect((await call({ body: jsonOfSize(MAX) })).status).toBe(200);
    expect(dispatched).toHaveLength(1);
    forgetCalls();
    await expectRefused(await call({ body: jsonOfSize(MAX + 1) }), 413, "PAYLOAD_TOO_LARGE");
  });

  test("with NO Content-Length the stream is cut off at the cap, not buffered to the end", async () => {
    const { state, body } = countingStream(32 * 1024 * 1024);
    const res = await streamRequest(body);
    await expectRefused(res, 413, "PAYLOAD_TOO_LARGE");
    expect(state.cancelled).toBe(true);
    // The runtime may read a chunk or two ahead, but nowhere near the 32 MiB that was on offer.
    expect(state.pulled).toBeLessThan(MAX + 512 * 1024);
  });

  test("a Content-Length that lies low does not help: the stream cap still applies", async () => {
    const res = await call({ headers: { "content-length": "10" }, body: jsonOfSize(MAX + 4096) });
    await expectRefused(res, 413, "PAYLOAD_TOO_LARGE");
  });

  test("a garbage Content-Length is ignored and the stream cap applies", async () => {
    await expectRefused(await call({ headers: { "content-length": "lots" }, body: jsonOfSize(MAX + 1) }), 413, "PAYLOAD_TOO_LARGE");
    expect((await call({ headers: { "content-length": "lots" } })).status).toBe(200);
  });

  test("the cap counts bytes, not characters (multi-byte text)", async () => {
    // 600,000 characters but 1,200,000 bytes.
    const body = JSON.stringify({ path: "videos.list", args: { pad: "é".repeat(600_000) } });
    expect(body.length).toBeLessThan(MAX);
    await expectRefused(await call({ body }), 413, "PAYLOAD_TOO_LARGE");
  });

  test("a large legitimate payload (a 50,000-character contact message) passes", async () => {
    const body = JSON.stringify({ path: "contact.send", args: { name: "n", email: "e@x.test", subject: "s", message: "m".repeat(50_000) } });
    expect((await call({ body })).status).toBe(200);
  });
});

describe("content type", () => {
  const accepted = [
    "application/json",
    "Application/JSON",
    "APPLICATION/JSON",
    "application/json; charset=utf-8",
    "application/json;charset=utf-8",
    "application/json;charset=UTF-8",
    "application/json ; charset=utf-8",
    'application/json; charset="utf-8"',
  ];
  for (const ct of accepted) test(`accepts ${JSON.stringify(ct)}`, async () => expect((await call({ headers: { "content-type": ct } })).status).toBe(200));

  const rejected = [
    "text/plain",
    "text/plain;application/json", //            substring match let this through
    "text/plain; application/json",
    "text/plain; charset=utf-8; application/json",
    "application/json-patch+json",
    "application/jsonx",
    "application/x-json",
    "application/vnd.api+json",
    "application/json, text/plain", //           two headers folded together
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=application/json",
    "application/json; charset=latin1",
    "application/json; charset=utf-16",
    "application/json; boundary=x",
    "application/json;",
    "",
  ];
  for (const ct of rejected) {
    test(`rejects ${JSON.stringify(ct)} as 415 without reading the body`, async () => {
      const { state, body } = countingStream(1024);
      const res = await streamRequest(body, { "content-type": ct });
      await expectRefused(res, 415, "UNSUPPORTED_MEDIA_TYPE");
      expect(state.pulled).toBe(0);
    });
  }

  test("rejects a request with no content type header at all", async () => {
    // A binary body is the one kind Request does not label for us.
    const req = new Request(URL_, { method: "POST", body: new TextEncoder().encode('{"path":"videos.list"}') });
    expect(req.headers.get("content-type")).toBeNull();
    await expectRefused(await POST(req), 415, "UNSUPPORTED_MEDIA_TYPE");
  });
});

describe("Origin header", () => {
  const withOrigin = (origin: string, extra: Record<string, string> = {}, url = URL_) => call({ url, headers: { origin, ...extra } });

  test("absent Origin is allowed", async () => {
    expect((await call()).status).toBe(200);
  });

  test("an Origin on the request's own host is allowed", async () => {
    expect((await withOrigin("https://app.test")).status).toBe(200);
    expect((await withOrigin("https://APP.test")).status).toBe(200);
  });

  const mismatches = [
    "https://evil.test",
    "https://app.test.evil.test",
    "https://evil.test/app.test",
    "https://app.test@evil.test",
    "https://app.test:8443", //   same name, other port
    "https://sub.app.test",
    "https://app.tes",
    "null", //                    sandboxed iframes and some redirects send the literal string
    "not a url",
    "",
    "javascript://app.test",
    "app.test",
  ];
  for (const origin of mismatches) {
    test(`refuses Origin ${JSON.stringify(origin)} with 403`, async () => {
      await expectRefused(await withOrigin(origin), 403, "FORBIDDEN");
    });
  }

  test("a refused Origin is refused even when Sec-Fetch-Site claims same-origin", async () => {
    await expectRefused(await withOrigin("https://evil.test", { "sec-fetch-site": "same-origin" }), 403, "FORBIDDEN");
  });

  test("Sec-Fetch-Site still wins over a matching Origin", async () => {
    await expectRefused(await withOrigin("https://app.test", { "sec-fetch-site": "cross-site" }), 403, "FORBIDDEN");
  });

  test("the http/https scheme is not compared (TLS is terminated before the app: req.url may say http)", async () => {
    expect((await withOrigin("https://reelcast.app", {}, "http://reelcast.app/api/rpc")).status).toBe(200);
  });

  test("localhost with a port", async () => {
    expect((await withOrigin("http://localhost:3000", {}, "http://localhost:3000/api/rpc")).status).toBe(200);
    forgetCalls();
    await expectRefused(await withOrigin("http://localhost:3001", {}, "http://localhost:3000/api/rpc"), 403, "FORBIDDEN");
  });

  test("behind a proxy: x-forwarded-host (first entry) is the public host", async () => {
    const internal = "http://10.0.0.7:3000/api/rpc";
    expect((await withOrigin("https://reelcast.app", { "x-forwarded-host": "reelcast.app" }, internal)).status).toBe(200);
    expect((await withOrigin("https://reelcast.app", { "x-forwarded-host": "reelcast.app, edge.internal" }, internal)).status).toBe(200);
    forgetCalls();
    await expectRefused(await withOrigin("https://evil.test", { "x-forwarded-host": "reelcast.app" }, internal), 403, "FORBIDDEN");
  });

  test("the Host header counts too (a preview deployment on its own domain)", async () => {
    const host = "reelcast-git-feature-x-team.vercel.app";
    expect((await withOrigin(`https://${host}`, { host }, "http://localhost:3000/api/rpc")).status).toBe(200);
  });

  test("a default port in Host is the same host as the Origin without it", async () => {
    expect((await withOrigin("https://reelcast.app", { host: "reelcast.app:443" }, "http://10.0.0.7:3000/api/rpc")).status).toBe(200);
  });

  test("NEXT_PUBLIC_APP_URL's host is always acceptable", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://reelcast.app/";
    const internal = "http://10.0.0.7:3000/api/rpc";
    expect((await withOrigin("https://reelcast.app", {}, internal)).status).toBe(200);
    forgetCalls();
    await expectRefused(await withOrigin("https://www.reelcast.app", {}, internal), 403, "FORBIDDEN");
  });

  test("a malformed NEXT_PUBLIC_APP_URL does not let anything through", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    await expectRefused(await withOrigin("https://evil.test"), 403, "FORBIDDEN");
    expect((await withOrigin("https://app.test")).status).toBe(200);
  });
});
