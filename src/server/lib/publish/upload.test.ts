import { describe, expect, test } from "bun:test";
import { classifyYouTubeFailure, YouTubeApiError } from "@/server/lib/youtube";
import { CLOUD_URL, FakeWorld, KIB256 } from "./testkit";
import { SourceMissingError, SourcePermanentError, getSourceSize, readSourceRange } from "./source";
import { uploadSlice, type UploadSession } from "./upload";

const noSleep = async () => {};
const SESSION = (n: number) => `https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S${n}`;

/** A world with one live session already created (as initiateResumableUpload would). */
async function worldWithSession(size: number) {
  const w = new FakeWorld(size);
  await w.fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST" });
  w.log.length = 0;
  const session: UploadSession = { sessionUri: SESSION(1), totalSize: size, chunkSize: KIB256 };
  return { w, session };
}

const run = (w: FakeWorld, session: UploadSession, budgetMs = 1_000_000) =>
  uploadSlice({ f: w.fetch, accessToken: "tok", sourceUrl: CLOUD_URL, session, budgetMs, now: w.now, sleep: noSleep });

describe("uploadSlice", () => {
  test("streams the file in contiguous 256KiB-multiple chunks and returns the video id", async () => {
    const { w, session } = await worldWithSession(3 * KIB256 + 1000);
    const out = await run(w, session);
    expect(out).toEqual({ kind: "done", videoId: "yt_video_1" });
    expect(w.chunkRanges).toEqual([
      `bytes 0-${KIB256 - 1}/${session.totalSize}`,
      `bytes ${KIB256}-${2 * KIB256 - 1}/${session.totalSize}`,
      `bytes ${2 * KIB256}-${3 * KIB256 - 1}/${session.totalSize}`,
      `bytes ${3 * KIB256}-${session.totalSize - 1}/${session.totalSize}`,
    ]);
  });

  test("a file smaller than one chunk goes up in a single PUT", async () => {
    const { w, session } = await worldWithSession(5000);
    expect(await run(w, session)).toEqual({ kind: "done", videoId: "yt_video_1" });
    expect(w.chunkRanges).toEqual(["bytes 0-4999/5000"]);
  });

  test("stops when the time budget is spent and reports where it is; the next slice resumes from Google's offset", async () => {
    const { w, session } = await worldWithSession(6 * KIB256);
    w.costMs = 10_000; // each chunk costs 20s (read + PUT)
    const first = await run(w, session, 50_000);
    expect(first.kind).toBe("progress");
    const reached = (first as { offset: number }).offset;
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(6 * KIB256);
    expect(reached % KIB256).toBe(0);

    // A "stale" stored counter is irrelevant: the second slice asks Google and continues from there.
    const sent = w.chunkRanges.length;
    const second = await run(w, session, 1_000_000);
    expect(second).toEqual({ kind: "done", videoId: "yt_video_1" });
    expect(w.chunkRanges.length).toBe(6); // every chunk sent exactly once across both slices
    expect(w.chunkRanges[sent]).toStartWith(`bytes ${reached}-`);
  });

  test("an upload Google already finished is recognised without sending a byte", async () => {
    const { w, session } = await worldWithSession(2 * KIB256);
    await run(w, session);
    const before = w.chunkRanges.length;
    expect(await run(w, session)).toEqual({ kind: "done", videoId: "yt_video_1" });
    expect(w.chunkRanges.length).toBe(before);
  });

  test("an expired session (404) is reported so the caller can start over", async () => {
    const { w, session } = await worldWithSession(2 * KIB256);
    w.sessions[0].alive = false;
    expect(await run(w, session)).toEqual({ kind: "expired" });
  });

  test("a 503 on a chunk that was NOT stored: re-query, then re-send it", async () => {
    const { w, session } = await worldWithSession(3 * KIB256);
    w.faults.set(1, { type: "status", status: 503 });
    expect(await run(w, session)).toEqual({ kind: "done", videoId: "yt_video_1" });
    expect(w.chunkRanges.length).toBe(4); // 3 chunks + the retried one
  });

  test("a dropped connection after Google STORED the chunk: the status query prevents a duplicate send", async () => {
    const { w, session } = await worldWithSession(3 * KIB256);
    w.faults.set(1, { type: "network", stored: true });
    expect(await run(w, session)).toEqual({ kind: "done", videoId: "yt_video_1" });
    expect(w.chunkRanges.length).toBe(3); // chunk 1 was not sent twice
  });

  test("a permanent 4xx from Google is thrown as a non-retryable YouTubeApiError", async () => {
    const { w, session } = await worldWithSession(2 * KIB256);
    w.faults.set(0, { type: "status", status: 400 });
    await expect(run(w, session)).rejects.toMatchObject({ name: "YouTubeApiError", status: 400, retryable: false });
  });

  test("gives up after repeated transient failures", async () => {
    const { w, session } = await worldWithSession(2 * KIB256);
    for (let i = 0; i < 10; i++) w.faults.set(i, { type: "status", status: 503 });
    await expect(run(w, session)).rejects.toMatchObject({ status: 503, retryable: true });
  });

  test("rejects chunk sizes that are not a multiple of 256KiB", async () => {
    const { w, session } = await worldWithSession(KIB256);
    await expect(run(w, { ...session, chunkSize: 1000 })).rejects.toThrow(/multiple of/);
  });
});

describe("source reading", () => {
  test("size comes from HEAD content-length", async () => {
    const w = new FakeWorld(12345);
    expect(await getSourceSize(CLOUD_URL, w.fetch)).toBe(12345);
  });

  test("404 means the file is gone", async () => {
    const w = new FakeWorld(10);
    w.storage.headStatus = 404;
    await expect(getSourceSize(CLOUD_URL, w.fetch)).rejects.toBeInstanceOf(SourceMissingError);
  });

  test("only Cloudinary https URLs are ever requested (SSRF guard)", async () => {
    const w = new FakeWorld(10);
    for (const bad of ["http://res.cloudinary.com/a/b.mp4", "https://evil.example/a.mp4", "https://169.254.169.254/latest/meta-data", "https://res.cloudinary.com.evil.example/x.mp4", "file:///etc/passwd", "not a url"]) {
      await expect(getSourceSize(bad, w.fetch)).rejects.toBeInstanceOf(SourcePermanentError);
      await expect(readSourceRange(bad, 0, 9, w.fetch)).rejects.toBeInstanceOf(SourcePermanentError);
    }
    expect(w.fetchCalls).toBe(0);
  });

  test("a host that ignores Range is acceptable from byte 0 but not for resuming", async () => {
    const w = new FakeWorld(1000);
    w.storage.supportsRange = false;
    const head = await readSourceRange(CLOUD_URL, 0, 99, w.fetch);
    expect(head.byteLength).toBe(100);
    expect(head[5]).toBe(w.file[5]);
    await expect(readSourceRange(CLOUD_URL, 100, 199, w.fetch)).rejects.toBeInstanceOf(SourcePermanentError);
  });

  test("a short body is a (retryable) error, not silently truncated data", async () => {
    const f = async () => new Response(new Uint8Array(10), { status: 206 });
    await expect(readSourceRange(CLOUD_URL, 0, 99, f)).rejects.toThrow(/10 of 100/);
  });
});

describe("classifyYouTubeFailure", () => {
  const body = (reason: string, message = "boom") => JSON.stringify({ error: { code: 403, message, errors: [{ reason }] } });
  const cases: [number, string, boolean][] = [
    [400, body("invalidMetadata"), false],
    [400, "not json", false],
    [401, body("authError"), true],
    [403, body("forbidden"), false],
    [403, body("insufficientPermissions"), false],
    [403, body("quotaExceeded"), true],
    [403, body("rateLimitExceeded"), true],
    [403, body("uploadLimitExceeded"), true],
    [404, body("videoNotFound"), false],
    [408, "", true],
    [429, "", true],
    [500, "", true],
    [503, "", true],
  ];
  for (const [status, text, retryable] of cases) {
    test(`${status} ${text.slice(0, 40) || "(empty)"} -> ${retryable ? "retryable" : "permanent"}`, () => {
      const e = classifyYouTubeFailure(status, text, "YouTube video upload failed");
      expect(e).toBeInstanceOf(YouTubeApiError);
      expect(e.retryable).toBe(retryable);
      expect(e.status).toBe(status);
    });
  }
  test("exposes Google's structured reason and keeps the message readable", () => {
    const e = classifyYouTubeFailure(403, body("quotaExceeded", "The request cannot be completed"), "YouTube upload initiation failed");
    expect(e.reason).toBe("quotaExceeded");
    expect(e.message).toBe("YouTube upload initiation failed: The request cannot be completed");
  });
});
