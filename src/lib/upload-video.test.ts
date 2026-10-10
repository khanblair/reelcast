import { describe, expect, test } from "bun:test";
import { buildVideoUploadForm, describeUploadFailure, type SignedVideoUpload } from "./upload-video";

const signed: SignedVideoUpload = {
  uploadUrl: "https://api.cloudinary.com/v1_1/demo-cloud/video/upload",
  apiKey: "123456789012345",
  signature: "a".repeat(40),
  params: {
    allowed_formats: "mp4,mov,webm",
    folder: "reelcast/videos/11111111-1111-4111-8111-111111111111",
    max_file_size: 104857600,
    overwrite: "false",
    public_id: "0123456789abcdef01234567",
    timestamp: 1760000000,
  },
};

describe("buildVideoUploadForm", () => {
  const file = new File(["video bytes"], "clip.mp4", { type: "video/mp4" });
  const form = buildVideoUploadForm(file, signed);

  test("sends every signed parameter, the key, the signature and the file, and nothing else", () => {
    expect([...form.keys()].sort()).toEqual([...Object.keys(signed.params), "api_key", "file", "signature"].sort());
    expect(new Set(form.keys()).size).toBe([...form.keys()].length); // no field twice
  });

  test("sends the signed values as text exactly as the server wrote them", () => {
    for (const [key, value] of Object.entries(signed.params)) expect(form.get(key)).toBe(String(value));
    expect(form.get("api_key")).toBe(signed.apiKey);
    expect(form.get("signature")).toBe(signed.signature);
  });

  test("the file is sent as the file", async () => {
    const sent = form.get("file") as File;
    expect(sent).toBeInstanceOf(Blob);
    expect(await sent.text()).toBe("video bytes");
  });

  test("follows whatever set the server signed, so adding a parameter there needs no change here", () => {
    const more = buildVideoUploadForm(file, { ...signed, params: { ...signed.params, context: "a=b" } });
    expect(more.get("context")).toBe("a=b");
  });

  test("never sends a field the server did not sign (no resource_type, no max_file_size of its own)", () => {
    const bare = buildVideoUploadForm(file, { ...signed, params: { timestamp: 1 } });
    expect([...bare.keys()].sort()).toEqual(["api_key", "file", "signature", "timestamp"]);
  });
});

describe("describeUploadFailure", () => {
  const cloudinary = (message: string) => JSON.stringify({ error: { message } });

  test("shows Cloudinary's own reason, for example a format that is not allowed", () => {
    expect(describeUploadFailure(400, cloudinary("Video format wmx is not allowed"))).toBe("Upload failed: Video format wmx is not allowed");
  });

  test("a rejected signature gets a plain sentence, not the signing details Cloudinary echoes back", () => {
    const text = describeUploadFailure(401, cloudinary("Invalid Signature abc123. String to sign - 'allowed_formats=mp4&folder=reelcast/videos/x'."));
    expect(text).toBe("Upload failed: the upload was not authorised or has expired. Please try again.");
    expect(text).not.toContain("folder");
  });

  test("falls back to the status when there is no usable message", () => {
    for (const body of ["", "<html>Bad gateway</html>", "null", "{}", JSON.stringify({ error: { message: 5 } }), JSON.stringify({ error: "x" })]) {
      expect(describeUploadFailure(502, body)).toBe("Upload failed: 502");
    }
  });

  test("a very long message is cut", () => {
    expect(describeUploadFailure(400, cloudinary("x".repeat(5000))).length).toBeLessThan(260);
  });
});
