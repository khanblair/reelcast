/**
 * Q-4: Veo submit and poll must not hang. No database and no real network: a fake Gemini API on 127.0.0.1
 * either never answers (the call must reject on its own timeout, retryably) or answers normally (the
 * success path must be unchanged and must carry the configured timeout).
 *
 * The module is imported as a namespace so that, against code without the fix, the assertions fail
 * instead of the whole file failing to load.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as ai from "@/server/lib/ai";
import { jsonResponse, never, setEnv, settle, startFakeServer, type FakeServer } from "@/lib/testing/fakeServer";

const OP = "models/veo-3.0-generate-001/operations/abc";
/** A call without a working timeout is still pending after this long. */
const GUARD_MS = 2_500;
const TEST_TIMEOUT_MS = 300;

let server: FakeServer | undefined;
let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = setEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: undefined, GOOGLE_CLOUD_PROJECT: undefined, GEMINI_API_KEY: undefined, GOOGLE_GEMINI_BASE_URL: undefined });
});
afterEach(() => {
  server?.stop();
  server = undefined;
  restoreEnv();
});

function serve(handler: Parameters<typeof startFakeServer>[0]): FakeServer {
  server = startFakeServer(handler);
  process.env.GOOGLE_GEMINI_BASE_URL = server.url; // read by the SDK when the client is built
  return server;
}

describe("Veo submit", () => {
  test("a hung submit rejects on its own timeout with a retryable error", async () => {
    const s = serve(never);
    const out = await settle(() => ai.submitVeoGeneration({ model: "veo-3", prompt: "a cat" }, "key", TEST_TIMEOUT_MS), GUARD_MS);

    expect(s.hits.length).toBeGreaterThan(0); // the request really reached the fake server
    expect(s.hits[0].path).toContain(":predictLongRunning");
    expect(out.state).toBe("rejected");
    if (out.state !== "rejected") return;
    expect(out.elapsedMs).toBeGreaterThanOrEqual(TEST_TIMEOUT_MS - 50);
    expect(out.elapsedMs).toBeLessThan(GUARD_MS);
    expect((out.error as Error).name).toBe("AiTimeoutError");
    expect((out.error as Error).message).toContain("Veo submit timed out");
    expect(ai.isPermanentAiError(out.error)).toBe(false); // generationJob rethrows it as a plain Error, so the queue retries
  });

  test("success is unchanged and the default timeout (60 s) is applied without leaking into the request body", async () => {
    const s = serve(() => jsonResponse({ name: OP }));
    const out = await ai.submitVeoGeneration({ model: "veo-3", prompt: "a cat", aspectRatio: "9:16", durationSeconds: 6 }, "key");

    expect(out).toEqual({ operationName: OP });
    expect(ai.VEO_SUBMIT_TIMEOUT_MS).toBe(60_000);
    expect(s.hits[0].headers.get("x-server-timeout")).toBe("60");
    const body = JSON.parse(s.hits[0].body) as { instances: { prompt: string }[]; parameters: Record<string, unknown> };
    expect(body.instances[0].prompt).toBe("a cat");
    expect(body.parameters.aspectRatio).toBe("9:16");
    expect(s.hits[0].body).not.toContain("httpOptions");
  });

  test("API errors keep their classification: a 4xx is permanent, a 503 is retryable", async () => {
    serve(() => jsonResponse({ error: { code: 400, message: "bad prompt", status: "INVALID_ARGUMENT" } }, { status: 400 }));
    const bad = await ai.submitVeoGeneration({ model: "veo-3", prompt: "p" }, "key").catch((e: unknown) => e);
    expect(ai.isPermanentAiError(bad)).toBe(true);
    server?.stop();

    serve(() => jsonResponse({ error: { code: 503, message: "busy", status: "UNAVAILABLE" } }, { status: 503 }));
    const busy = await ai.submitVeoGeneration({ model: "veo-3", prompt: "p" }, "key").catch((e: unknown) => e);
    expect(ai.isPermanentAiError(busy)).toBe(false);
    expect((busy as Error).name).not.toBe("AiTimeoutError");
  });
});

describe("Veo poll", () => {
  test("a hung poll rejects on its own timeout with a retryable error", async () => {
    const s = serve(never);
    const out = await settle(() => ai.pollVeoOperation(OP, "key", TEST_TIMEOUT_MS), GUARD_MS);

    expect(s.hits.length).toBeGreaterThan(0);
    expect(s.hits[0].method).toBe("GET");
    expect(s.hits[0].path).toContain("/operations/abc");
    expect(out.state).toBe("rejected");
    if (out.state !== "rejected") return;
    expect(out.elapsedMs).toBeGreaterThanOrEqual(TEST_TIMEOUT_MS - 50);
    expect(out.elapsedMs).toBeLessThan(GUARD_MS);
    expect((out.error as Error).name).toBe("AiTimeoutError");
    expect((out.error as Error).message).toContain("Veo poll timed out");
    expect(ai.isPermanentAiError(out.error)).toBe(false);
  });

  test("success is unchanged and the default timeout (30 s) is applied", async () => {
    const s = serve(() => jsonResponse({ name: OP, done: false }));
    expect(await ai.pollVeoOperation(OP, "key")).toEqual({ operationName: OP, done: false });
    expect(ai.VEO_POLL_TIMEOUT_MS).toBe(30_000);
    expect(s.hits[0].headers.get("x-server-timeout")).toBe("30");

    server?.stop();
    serve(() =>
      jsonResponse({
        name: OP,
        done: true,
        response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/xyz:download?alt=media" } }] } },
      }),
    );
    const done = await ai.pollVeoOperation(OP, "key");
    expect(done.done).toBe(true);
    expect(done.videoUri).toContain("/files/xyz");
  });

  test("an operation that failed on Google's side is still a permanent error", async () => {
    serve(() => jsonResponse({ name: OP, done: true, error: { code: 3, message: "blocked" } }));
    const err = await ai.pollVeoOperation(OP, "key").catch((e: unknown) => e);
    expect(ai.isPermanentAiError(err)).toBe(true);
  });
});
