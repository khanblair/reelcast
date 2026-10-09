/** No database: Veo SDK usage, the streaming download and the Cloudinary uploader, all against a mocked fetch. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { VeoOperationError, isPermanentAiError, openVeoDownload, pollVeoOperation, submitVeoGeneration } from "@/server/lib/ai";
import { cloudinaryPosterUrl, uploadBytesToCloudinary, uploadResponseToCloudinary } from "./cloudinaryUpload";
import { json, mockFetch, setEnv } from "./testkit";

let restoreEnv: () => void;
let net: ReturnType<typeof mockFetch>;
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  restoreEnv = setEnv({
    GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
    GOOGLE_CLOUD_PROJECT: undefined,
    GEMINI_API_KEY: undefined,
    NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "democloud",
    CLOUDINARY_API_KEY: "cld-key",
    CLOUDINARY_API_SECRET: "cld-secret",
  });
  handler = () => new Response("not mocked", { status: 404 });
  net = mockFetch((url, init) => handler(url, init));
});
afterEach(() => {
  net.restore();
  restoreEnv();
});

describe("Veo via the Gemini Developer API", () => {
  test("submit sends the model + config and returns the operation name; no credentials is a permanent error", async () => {
    const noCreds = await submitVeoGeneration({ model: "veo-3", prompt: "p" }, null).catch((e: unknown) => e);
    expect(noCreds).toMatchObject({ name: "AiNotConfiguredError" });
    expect(isPermanentAiError(noCreds)).toBe(true);

    handler = () => json({ name: "models/veo-3.0-generate-001/operations/abc" });
    const out = await submitVeoGeneration({ model: "veo-3", prompt: "a cat", aspectRatio: "9:16", durationSeconds: 6, generateAudio: true }, "key-123");
    expect(out).toEqual({ operationName: "models/veo-3.0-generate-001/operations/abc" });
    expect(net.calls[0].url).toContain("models/veo-3.0-generate-001:predictLongRunning");
    const body = JSON.parse(String(net.calls[0].init!.body)) as { instances: { prompt: string }[]; parameters: Record<string, unknown> };
    expect(body.instances[0].prompt).toBe("a cat");
    expect(body.parameters.aspectRatio).toBe("9:16");
    expect(body.parameters.durationSeconds).toBe(6);
    expect("generateAudio" in body.parameters).toBe(false); // not supported on the Developer API

    await expect(submitVeoGeneration({ model: "nope", prompt: "p" }, "key-123")).rejects.toBeInstanceOf(VeoOperationError);
  });

  test("poll: pending, done with a Files URI, and failed operations", async () => {
    handler = () => json({ name: "models/veo-3.0-generate-001/operations/abc", done: false });
    expect(await pollVeoOperation("models/veo-3.0-generate-001/operations/abc", "key-123")).toEqual({ operationName: "models/veo-3.0-generate-001/operations/abc", done: false });
    expect(net.calls[0].url).toContain("operations/abc");

    handler = () =>
      json({
        name: "models/veo-3.0-generate-001/operations/abc",
        done: true,
        response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/xyz:download?alt=media" } }] } },
      });
    const done = await pollVeoOperation("models/veo-3.0-generate-001/operations/abc", "key-123");
    expect(done.done).toBe(true);
    expect(done.videoUri).toContain("/files/xyz");

    handler = () => json({ name: "x", done: true, error: { code: 3, message: "blocked by safety" } });
    const err = await pollVeoOperation("x", "key-123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VeoOperationError);
    expect((err as Error).message).toContain("blocked by safety");

    handler = () => json({ name: "x", done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ["minors"] } } });
    expect(((await pollVeoOperation("x", "key-123").catch((e: unknown) => e)) as Error).message).toContain("minors");
  });
});

describe("openVeoDownload", () => {
  test("normalises both URI shapes, sends the key as a header (never in the URL), falls back on failure", async () => {
    handler = (url) => (url.includes(":download") ? new Response("nope", { status: 400 }) : new Response(new Uint8Array([1]), { status: 200 }));
    const res = await openVeoDownload("https://generativelanguage.googleapis.com/v1beta/files/xyz:download?alt=media", "key-123");
    expect(res.ok).toBe(true);
    expect(net.calls.map((c) => c.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/files/xyz:download?alt=media",
      "https://generativelanguage.googleapis.com/v1beta/files/xyz?alt=media",
    ]);
    for (const c of net.calls) {
      expect(c.url).not.toContain("key-123");
      expect((c.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("key-123");
    }
    await res.body?.cancel();
  });

  test("refuses other hosts and reports exhausted fallbacks", async () => {
    await expect(openVeoDownload("https://evil.example.com/files/x", "k")).rejects.toBeInstanceOf(VeoOperationError);
    await expect(openVeoDownload("gs://bucket/out.mp4", "k")).rejects.toBeInstanceOf(VeoOperationError);
    handler = () => new Response("gone", { status: 404 });
    await expect(openVeoDownload("https://generativelanguage.googleapis.com/v1beta/files/xyz", "k")).rejects.toThrow("404");
  });
});

describe("Cloudinary upload", () => {
  const form = (init?: RequestInit) => init!.body as FormData;

  test("small body: one signed multipart request with overwrite=true", async () => {
    handler = () => json({ secure_url: "https://res.cloudinary.com/democloud/video/upload/v1/generated/a.mp4", bytes: 4 });
    const res = new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-length": "4" } });
    const out = await uploadResponseToCloudinary(res, "generated/vid_gen", "video/mp4");
    expect(out).toEqual({ secureUrl: "https://res.cloudinary.com/democloud/video/upload/v1/generated/a.mp4", bytes: 4, publicId: "generated/vid_gen" });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe("https://api.cloudinary.com/v1_1/democloud/video/upload");
    const f = form(net.calls[0].init);
    expect(f.get("public_id")).toBe("generated/vid_gen");
    expect(f.get("overwrite")).toBe("true");
    expect(f.get("api_key")).toBe("cld-key");
    expect((f.get("file") as Blob).size).toBe(4);
    const expected = createHash("sha1").update(`overwrite=true&public_id=generated/vid_gen&timestamp=${f.get("timestamp")}cld-secret`).digest("hex");
    expect(f.get("signature")).toBe(expected);
    expect([...f.keys()]).not.toContain("api_secret"); // the secret is only ever mixed into the signature
  });

  test("large body: streamed in >=5MB chunks with Content-Range, memory bounded by the chunk size", async () => {
    const total = 20 * 1024 * 1024 + 123;
    const piece = new Uint8Array(1024 * 1024).fill(7);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const left = total - sent;
        if (left <= 0) return controller.close();
        const n = Math.min(left, piece.byteLength);
        controller.enqueue(piece.subarray(0, n));
        sent += n;
      },
    });
    const sizes: number[] = [];
    const ranges: string[] = [];
    const ids = new Set<string>();
    handler = (_url, init) => {
      const h = init!.headers as Record<string, string>;
      ranges.push(h["Content-Range"]);
      ids.add(h["X-Unique-Upload-Id"]);
      sizes.push((form(init).get("file") as Blob).size);
      return json(ranges.length >= 3 ? { secure_url: "https://res.cloudinary.com/democloud/video/upload/v1/big.mp4", bytes: total } : { done: false });
    };
    const out = await uploadResponseToCloudinary(new Response(stream, { headers: { "content-length": String(total) } }), "generated/big");
    expect(out.secureUrl).toBe("https://res.cloudinary.com/democloud/video/upload/v1/big.mp4");
    const CHUNK = 8 * 1024 * 1024;
    expect(sizes).toEqual([CHUNK, CHUNK, total - 2 * CHUNK]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
    expect(ranges).toEqual([`bytes 0-${CHUNK - 1}/${total}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`, `bytes ${2 * CHUNK}-${total - 1}/${total}`]);
    expect(ids.size).toBe(1); // one upload session
  });

  test("bytes upload, error propagation and the poster URL", async () => {
    handler = () => new Response("bad signature", { status: 401 });
    await expect(uploadBytesToCloudinary(new Uint8Array([1]), "generated/x")).rejects.toThrow("Cloudinary upload failed: 401");
    restoreEnv();
    restoreEnv = setEnv({ CLOUDINARY_API_SECRET: undefined });
    await expect(uploadBytesToCloudinary(new Uint8Array([1]), "generated/x")).rejects.toThrow("not configured");
    expect(cloudinaryPosterUrl("https://res.cloudinary.com/c/video/upload/v1/generated/a.mp4")).toBe("https://res.cloudinary.com/c/video/upload/so_1,w_640,h_360,c_fill/v1/generated/a.jpg");
  });
});
