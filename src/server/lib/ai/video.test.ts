/**
 * Q-4: the Gemini Files API fallback (upload + status polling) must not hang. No database and no real
 * network: a fake Files API on 127.0.0.1 either never answers (the call must reject on its own timeout,
 * retryably) or answers normally (the success path must be unchanged).
 *
 * The Cloudinary download is stubbed through global fetch; every other URL goes to the real fetch with its
 * init (and so its abort signal) untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GoogleGenAI } from "@google/genai";
import * as aiLib from "@/server/lib/ai";
import { jsonResponse, never, settle, startFakeServer, type FakeServer } from "@/lib/testing/fakeServer";
import * as video from "./video";

const CLOUDINARY_URL = "https://res.cloudinary.com/demo/video/upload/v1/clip.mp4";
/** A call without a working timeout is still pending after this long. */
const GUARD_MS = 2_500;

type Plan = {
  /** What the resumable-upload start request does. */
  start: "ok" | "hang";
  /** What the chunk upload does. */
  chunk: "ok" | "hang";
  /** Successive answers of `files.get`; the last one repeats. */
  poll: Array<"PROCESSING" | "ACTIVE" | "FAILED" | "hang">;
};

let server: FakeServer;
let realFetch: typeof fetch;
let polls: number;

function startFilesApi(plan: Plan): void {
  polls = 0;
  server = startFakeServer((hit) => {
    const file = (state: string) => ({ name: "files/abc", uri: `${server.url}/v1beta/files/abc`, mimeType: "video/mp4", state });
    if (hit.method === "POST" && hit.path === "/upload/v1beta/files") {
      return plan.start === "hang" ? never() : jsonResponse({}, { headers: { "x-goog-upload-url": `${server.url}/upload-target/abc` } });
    }
    if (hit.method === "POST" && hit.path === "/upload-target/abc") {
      return plan.chunk === "hang" ? never() : jsonResponse({ file: file("PROCESSING") }, { headers: { "x-goog-upload-status": "final" } });
    }
    if (hit.method === "GET" && hit.path === "/v1beta/files/abc") {
      const step = plan.poll[Math.min(polls++, plan.poll.length - 1)];
      return step === "hang" ? never() : jsonResponse(file(step));
    }
    return new Response("unexpected", { status: 404 });
  });
}

const client = () => new GoogleGenAI({ apiKey: "key", httpOptions: { baseUrl: server.url } });

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://res.cloudinary.com/")) {
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "video/mp4", "content-length": "4" } }));
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  server?.stop();
});

function expectRetryableTimeout(out: Awaited<ReturnType<typeof settle>>, label: string, minMs: number): void {
  expect(out.state).toBe("rejected");
  if (out.state !== "rejected") return;
  expect(out.elapsedMs).toBeGreaterThanOrEqual(minMs - 50);
  expect(out.elapsedMs).toBeLessThan(GUARD_MS);
  expect((out.error as Error).name).toBe("AiTimeoutError");
  expect((out.error as Error).message).toContain(label);
  expect(aiLib.isPermanentAiError(out.error)).toBe(false); // plain/retryable: the job retries with backoff
}

describe("Gemini Files API fallback", () => {
  test("a hung upload start is abandoned after the per-call timeout", async () => {
    startFilesApi({ start: "hang", chunk: "ok", poll: ["ACTIVE"] });
    const out = await settle(() => video.geminiVideoFilePart(client(), CLOUDINARY_URL, Date.now() + 60_000, { maxCallMs: 300 }), GUARD_MS);

    expect(server.hits.map((h) => h.path)).toContain("/upload/v1beta/files"); // it really reached the fake server
    expectRetryableTimeout(out, "Gemini Files API upload timed out", 300);
  });

  test("a hung chunk upload is abandoned too (the SDK takes no per-request timeout for it)", async () => {
    startFilesApi({ start: "ok", chunk: "hang", poll: ["ACTIVE"] });
    const out = await settle(() => video.geminiVideoFilePart(client(), CLOUDINARY_URL, Date.now() + 60_000, { maxCallMs: 300 }), GUARD_MS);

    expect(server.hits.map((h) => h.path)).toContain("/upload-target/abc");
    expectRetryableTimeout(out, "Gemini Files API upload timed out", 300);
  });

  test("a hung status poll is aborted by the SDK timeout", async () => {
    startFilesApi({ start: "ok", chunk: "ok", poll: ["hang"] });
    const out = await settle(() => video.geminiVideoFilePart(client(), CLOUDINARY_URL, Date.now() + 60_000, { maxCallMs: 300, pollIntervalMs: 5 }), GUARD_MS);

    expect(polls).toBeGreaterThan(0); // the status request reached the fake server
    expectRetryableTimeout(out, "Gemini Files API status check timed out", 300);
  });

  test("the per-call timeout never drops to zero (the SDK reads 0 as 'no timeout') when the budget is spent", async () => {
    startFilesApi({ start: "hang", chunk: "ok", poll: ["ACTIVE"] });
    const out = await settle(
      () => video.geminiVideoFilePart(client(), CLOUDINARY_URL, Date.now() - 5_000, { minCallMs: 250, maxCallMs: 5_000 }),
      GUARD_MS,
    );

    expectRetryableTimeout(out, "Gemini Files API upload timed out", 250);
  });

  test("success is unchanged: resumable upload, then poll until ACTIVE", async () => {
    startFilesApi({ start: "ok", chunk: "ok", poll: ["PROCESSING", "ACTIVE"] });
    const part = await video.geminiVideoFilePart(client(), CLOUDINARY_URL, Date.now() + 60_000, { pollIntervalMs: 5 });

    expect(part).toEqual({ fileData: { fileUri: `${server.url}/v1beta/files/abc`, mimeType: "video/mp4" } });
    const start = server.hits[0];
    expect(start.path).toBe("/upload/v1beta/files"); // not double-versioned
    expect(start.headers.get("x-goog-upload-protocol")).toBe("resumable");
    expect(start.headers.get("x-goog-upload-command")).toBe("start");
    expect(polls).toBe(2);
  });

  test("each call is bounded by the time left, and never by more than 120 s", async () => {
    expect(video.FILES_API_MAX_CALL_MS).toBe(120_000);

    startFilesApi({ start: "ok", chunk: "ok", poll: ["PROCESSING", "ACTIVE"] });
    await video.geminiVideoFilePart(client(), CLOUDINARY_URL, Date.now() + 30_000, { pollIntervalMs: 5 });
    const nearDeadline = Number(server.hits.find((h) => h.method === "GET")!.headers.get("x-server-timeout"));
    expect(nearDeadline).toBeGreaterThanOrEqual(25);
    expect(nearDeadline).toBeLessThanOrEqual(30);
    server.stop();

    startFilesApi({ start: "ok", chunk: "ok", poll: ["PROCESSING", "ACTIVE"] });
    await video.geminiVideoFilePart(client(), CLOUDINARY_URL, Date.now() + 10 * 60_000, { pollIntervalMs: 5 });
    expect(server.hits.find((h) => h.method === "GET")!.headers.get("x-server-timeout")).toBe("120");
  });

  test("a file Gemini failed to process is still a permanent error", async () => {
    startFilesApi({ start: "ok", chunk: "ok", poll: ["PROCESSING", "FAILED"] });
    const err = await video.geminiVideoFilePart(client(), CLOUDINARY_URL, Date.now() + 60_000, { pollIntervalMs: 5 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(aiLib.PermanentAiError);
  });
});
