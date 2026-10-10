/**
 * POST /api/cloudinary/sign (scaling ladder R-8): the server decides everything about a video upload and signs it all.
 *
 * Only the session lookup is faked; the route, the parameter builder and Cloudinary's own SDK signer are the real ones.
 * The expected signature is computed here with an independent copy of Cloudinary's documented algorithm
 * (sha1 over the sorted `key=value` pairs joined with `&`, with the API secret appended), using a fake secret.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const SECRET = "fake_api_secret_for_tests_only";
const API_KEY = "123456789012345";
const CLOUD = "demo-cloud";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MB = 1024 * 1024;

type AuthModule = typeof import("@/server/auth");
let realAuth: AuthModule;
let POST: () => Promise<Response>;
let session: { id: string; plan: string } | null | "throws" = null;

beforeAll(async () => {
  realAuth = await import("@/server/auth");
  mock.module("@/server/auth", () => ({
    ...realAuth,
    getSessionUser: async () => {
      if (session === "throws") throw new Error("auth is down");
      return session;
    },
  }));
  ({ POST } = await import("./route"));
});

afterAll(() => {
  // mock.module is process-wide: put the real module back for any test file that runs after this one.
  mock.module("@/server/auth", () => realAuth);
});

const ENV_KEYS = ["CLOUDINARY_API_SECRET", "CLOUDINARY_API_KEY", "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.CLOUDINARY_API_SECRET = SECRET;
  process.env.CLOUDINARY_API_KEY = API_KEY;
  process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = CLOUD;
  session = { id: ME, plan: "free" };
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

type Signed = {
  uploadUrl: string;
  apiKey: string;
  signature: string;
  params: Record<string, string | number>;
};
const sign = async () => {
  const res = await POST();
  expect(res.status).toBe(200);
  return { res, body: (await res.json()) as Signed };
};

/** Cloudinary's documented signing algorithm, written out independently of the SDK. */
function cloudinarySignature(params: Record<string, string | number>, secret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`.replace(/&/g, "%26"))
    .join("&");
  return createHash("sha1").update(toSign + secret).digest("hex");
}

describe("who may sign", () => {
  test("a signed-out caller is refused and gets no signature", async () => {
    session = null;
    const res = await POST();
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "Unauthorized" });
    expect(text).not.toContain("signature");
  });

  test("a session lookup that throws is a refusal, not a 500", async () => {
    session = "throws";
    expect((await POST()).status).toBe(401);
  });

  test("missing server configuration is a 500 and never an unsigned or half-signed answer", async () => {
    for (const key of ENV_KEYS) {
      const keep = process.env[key];
      delete process.env[key];
      const res = await POST();
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Server misconfiguration" });
      process.env[key] = keep;
    }
  });
});

describe("what the server fixes", () => {
  test("the folder is the caller's own, the id is random, only video formats, no overwriting", async () => {
    const { body } = await sign();
    expect(body.params.folder).toBe(`reelcast/videos/${ME}`);
    expect(body.params.public_id).toMatch(/^[a-f0-9]{24}$/);
    expect(body.params.overwrite).toBe("false");
    const formats = String(body.params.allowed_formats).split(",");
    expect(formats).toEqual(expect.arrayContaining(["mp4", "mov", "webm"]));
    for (const never of ["jpg", "jpeg", "png", "gif", "svg", "html", "js", "php", "exe", "pdf", "zip", "txt", "raw", "auto"]) {
      expect(formats).not.toContain(never);
    }
    expect(Math.abs(Number(body.params.timestamp) - Date.now() / 1000)).toBeLessThan(10);
  });

  test("another user gets their own folder", async () => {
    session = { id: OTHER, plan: "free" };
    const { body } = await sign();
    expect(body.params.folder).toBe(`reelcast/videos/${OTHER}`);
  });

  test("the signed parameters are exactly this set, so nothing the client adds later is covered", async () => {
    const { body } = await sign();
    expect(Object.keys(body.params).sort()).toEqual(["allowed_formats", "folder", "max_file_size", "overwrite", "public_id", "timestamp"]);
    // Cloudinary never signs these; signing them would make every real upload fail with "Invalid Signature".
    for (const never of ["file", "api_key", "cloud_name", "resource_type", "signature"]) expect(body.params).not.toHaveProperty(never);
  });

  test("the upload goes to the video endpoint of our own cloud", async () => {
    const { body } = await sign();
    expect(body.uploadUrl).toBe(`https://api.cloudinary.com/v1_1/${CLOUD}/video/upload`);
    expect(body.apiKey).toBe(API_KEY);
  });

  test("the size limit follows the plan", async () => {
    for (const [plan, limit] of [["free", 100 * MB], ["pro", 500 * MB], ["elite", 2048 * MB], ["something-new", 100 * MB]] as const) {
      session = { id: ME, plan };
      const { body } = await sign();
      expect(body.params.max_file_size).toBe(limit);
    }
  });

  test("every call gets a fresh id and therefore a fresh signature", async () => {
    const a = (await sign()).body;
    const b = (await sign()).body;
    expect(a.params.public_id).not.toBe(b.params.public_id);
    expect(a.signature).not.toBe(b.signature);
  });

  test("the answer is not cacheable and never contains the secret", async () => {
    const { res } = await sign();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const again = await POST();
    expect(await again.text()).not.toContain(SECRET);
  });
});

describe("the signature", () => {
  test("is Cloudinary's sha1 of the sorted parameters plus the secret", async () => {
    const { body } = await sign();
    expect(body.signature).toBe(cloudinarySignature(body.params, SECRET));
    expect(body.signature).toMatch(/^[a-f0-9]{40}$/);
  });

  test("changes if ANY signed parameter is changed (the browser cannot swap folder, id, formats, size, overwrite or time)", async () => {
    const { body } = await sign();
    for (const key of Object.keys(body.params)) {
      const tampered = { ...body.params, [key]: `${body.params[key]}x` };
      expect(cloudinarySignature(tampered, SECRET)).not.toBe(body.signature);
    }
    expect(cloudinarySignature({ ...body.params, folder: `reelcast/videos/${OTHER}` }, SECRET)).not.toBe(body.signature);
    expect(cloudinarySignature({ ...body.params, extra: "1" }, SECRET)).not.toBe(body.signature);
  });

  test("is not valid under a different secret", async () => {
    const { body } = await sign();
    expect(cloudinarySignature(body.params, "another_secret")).not.toBe(body.signature);
  });

  test("covers every field the client assembler sends, and the assembler sends nothing else", async () => {
    const { buildVideoUploadForm } = await import("@/lib/upload-video");
    const { body } = await sign();
    const form = buildVideoUploadForm(new Blob(["x"], { type: "video/mp4" }), body);

    const fields: Record<string, string> = {};
    for (const [key, value] of form.entries()) if (typeof value === "string") fields[key] = value;
    expect([...new Set(form.keys())].sort()).toEqual(["allowed_formats", "api_key", "file", "folder", "max_file_size", "overwrite", "public_id", "signature", "timestamp"]);

    const { api_key, signature, ...signedFields } = fields;
    expect(api_key).toBe(API_KEY);
    expect(signature).toBe(body.signature);
    expect(cloudinarySignature(signedFields, SECRET)).toBe(body.signature);
  });
});
