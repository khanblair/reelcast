/**
 * Signed Cloudinary video upload for server-side copies (Veo output).
 *
 * Memory: a download is streamed. Up to SINGLE_MAX bytes it is uploaded in one multipart
 * request; larger bodies (with a known Content-Length) go through Cloudinary's chunked upload
 * (`X-Unique-Upload-Id` + `Content-Range`), holding at most CHUNK bytes at a time. Nothing is
 * ever base64-encoded.
 *
 * Idempotent: the public id is caller-supplied and `overwrite=true` is signed, so re-running
 * after a crash replaces the earlier copy instead of leaving an orphan.
 */
import { createHash, randomUUID } from "node:crypto";

const SINGLE_MAX = 16 * 1024 * 1024;
/** Cloudinary requires every chunk except the last to be >= 5 MB. */
const CHUNK = 8 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;

export type CloudinaryUploadResult = { secureUrl: string; bytes: number; publicId: string };

function creds() {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary credentials not configured");
  return { cloudName, apiKey, apiSecret };
}

type Signed = { timestamp: string; signature: string; apiKey: string; publicId: string; endpoint: string };

function sign(publicId: string): Signed {
  const { cloudName, apiKey, apiSecret } = creds();
  const timestamp = String(Math.floor(Date.now() / 1000));
  // Signature = sha1 of the sorted `k=v&...` params (excluding file/api_key/resource_type) + secret.
  const toSign = `overwrite=true&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = createHash("sha1").update(toSign + apiSecret).digest("hex");
  return { timestamp, signature, apiKey, publicId, endpoint: `https://api.cloudinary.com/v1_1/${cloudName}/video/upload` };
}

function form(s: Signed, file: Blob, filename: string): FormData {
  const f = new FormData();
  f.append("file", file, filename);
  f.append("public_id", s.publicId);
  f.append("overwrite", "true");
  f.append("timestamp", s.timestamp);
  f.append("signature", s.signature);
  f.append("api_key", s.apiKey);
  return f;
}

async function post(s: Signed, file: Blob, filename: string, headers: Record<string, string> = {}): Promise<{ secure_url?: string; bytes?: number }> {
  const res = await fetch(s.endpoint, {
    method: "POST",
    body: form(s, file, filename),
    headers,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloudinary upload failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as { secure_url?: string; bytes?: number };
}

/** Read the stream into a single Blob (only used for small / unknown-length bodies). */
async function drain(body: ReadableStream<Uint8Array>, mimeType: string): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(new Uint8Array(value));
  }
  return new Blob(parts, { type: mimeType });
}

/**
 * Upload a streamed HTTP response body (e.g. the Veo download) to Cloudinary.
 * `res` must be an OK response with a body.
 */
export async function uploadResponseToCloudinary(res: Response, publicId: string, mimeType = "video/mp4"): Promise<CloudinaryUploadResult> {
  if (!res.body) throw new Error("Download response has no body");
  const s = sign(publicId);
  const filename = `${publicId.split("/").pop() ?? "video"}.mp4`;
  const total = Number(res.headers.get("content-length") ?? "");

  if (!Number.isFinite(total) || total <= SINGLE_MAX) {
    const blob = await drain(res.body, mimeType);
    const out = await post(s, blob, filename);
    if (!out.secure_url) throw new Error("Cloudinary did not return a URL");
    return { secureUrl: out.secure_url, bytes: out.bytes ?? blob.size, publicId };
  }

  // Chunked streaming upload.
  const uploadId = randomUUID();
  const reader = res.body.getReader();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let sent = 0;
  let last: { secure_url?: string; bytes?: number } = {};

  const flush = async (final: boolean) => {
    const size = final ? pendingBytes : CHUNK;
    const chunk = new Uint8Array(size);
    let off = 0;
    const rest: Uint8Array[] = [];
    for (const p of pending) {
      if (off >= size) {
        rest.push(p);
        continue;
      }
      const take = Math.min(p.byteLength, size - off);
      chunk.set(p.subarray(0, take), off);
      off += take;
      if (take < p.byteLength) rest.push(p.subarray(take));
    }
    pending = rest;
    pendingBytes -= size;
    const start = sent;
    const end = start + size - 1;
    last = await post(s, new Blob([chunk], { type: mimeType }), filename, {
      "X-Unique-Upload-Id": uploadId,
      "Content-Range": `bytes ${start}-${end}/${total}`,
    });
    sent += size;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      pending.push(value);
      pendingBytes += value.byteLength;
      while (pendingBytes >= CHUNK + 1) await flush(false);
    }
    if (done) break;
  }
  if (pendingBytes > 0) await flush(true);
  if (sent !== total) throw new Error(`Cloudinary chunked upload size mismatch (${sent}/${total})`);
  if (!last.secure_url) throw new Error("Cloudinary did not return a URL");
  return { secureUrl: last.secure_url, bytes: last.bytes ?? total, publicId };
}

/** Upload already-in-memory bytes (Vertex AI returns inline video bytes). */
export async function uploadBytesToCloudinary(bytes: Uint8Array<ArrayBuffer>, publicId: string, mimeType = "video/mp4"): Promise<CloudinaryUploadResult> {
  const s = sign(publicId);
  const out = await post(s, new Blob([bytes], { type: mimeType }), `${publicId.split("/").pop() ?? "video"}.mp4`);
  if (!out.secure_url) throw new Error("Cloudinary did not return a URL");
  return { secureUrl: out.secure_url, bytes: out.bytes ?? bytes.byteLength, publicId };
}

/** JPEG poster frame derived from a Cloudinary video URL (no extra upload). */
export function cloudinaryPosterUrl(videoUrl: string): string {
  return videoUrl.replace("/upload/", "/upload/so_1,w_640,h_360,c_fill/").replace(/\.[a-z0-9]+(\?.*)?$/i, ".jpg");
}
