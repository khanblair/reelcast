/**
 * Reading the video file from storage (Cloudinary) in byte ranges, so a 2 GB file is never held
 * in memory: each chunk is fetched with `Range: bytes=a-b` and handed straight to YouTube.
 */
import { isAllowedMediaUrl } from "@/server/lib/cloudinary";
import type { FetchLike } from "@/server/lib/youtube";

/** The file is gone from storage (404/410). Permanent: the user must re-upload. */
export class SourceMissingError extends Error {
  constructor(message = "The video file is no longer in storage.") {
    super(message);
    this.name = "SourceMissingError";
  }
}

/** Storage answered, but not in a way that can ever succeed (403, bad range, no range support, bad size). */
export class SourcePermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePermanentError";
  }
}

function failFor(status: number, what: string): Error {
  if (status === 404 || status === 410) return new SourceMissingError();
  if (status === 408 || status === 429 || status >= 500) return new Error(`${what}: storage returned ${status}`);
  return new SourcePermanentError(`${what}: storage returned ${status}`);
}

function assertAllowed(url: string): void {
  if (!isAllowedMediaUrl(url)) throw new SourcePermanentError("The video file location is not a supported storage URL.");
}

/** Total size in bytes, from HEAD `Content-Length`, falling back to the `Content-Range` of a 1-byte ranged GET. */
export async function getSourceSize(url: string, f: FetchLike, timeoutMs = 20_000): Promise<number> {
  assertAllowed(url);
  const head = await f(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (head.ok) {
    const len = Number(head.headers.get("content-length"));
    if (Number.isFinite(len) && len > 0) return len;
  } else if (head.status === 404 || head.status === 410) {
    throw new SourceMissingError();
  }

  const probe = await f(url, { headers: { Range: "bytes=0-0" }, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!probe.ok) throw failFor(probe.status, "Failed to read video size from storage");
  await probe.body?.cancel().catch(() => undefined);
  const m = /\/(\d+)\s*$/.exec(probe.headers.get("content-range") ?? "");
  const total = m ? Number(m[1]) : Number(probe.headers.get("content-length"));
  if (!Number.isFinite(total) || total <= 0) throw new SourcePermanentError("Could not determine the video file size from storage.");
  return total;
}

/**
 * Bytes [start, endInclusive] of the file. Requires a 206 (the server honoured the range). A 200
 * is only acceptable for a read from byte 0, where the first `length` bytes of the body are taken
 * and the rest of the stream is cancelled; for any later offset it means the host ignores Range,
 * which cannot be resumed efficiently, so it is a permanent failure.
 */
export async function readSourceRange(url: string, start: number, endInclusive: number, f: FetchLike, timeoutMs = 60_000): Promise<Uint8Array> {
  assertAllowed(url);
  const length = endInclusive - start + 1;
  // no-store: a cached copy of a 16 MiB range would be silently wrong data, not just stale.
  const res = await f(url, { headers: { Range: `bytes=${start}-${endInclusive}` }, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });

  if (res.status === 416) {
    await res.body?.cancel().catch(() => undefined);
    throw new SourcePermanentError("The video file is smaller than expected (it changed after the upload started).");
  }
  if (res.status !== 206 && res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw failFor(res.status, "Failed to fetch video from storage");
  }
  if (res.status === 200 && start > 0) {
    await res.body?.cancel().catch(() => undefined);
    throw new SourcePermanentError("Storage does not support range requests, so the upload cannot be resumed.");
  }
  if (!res.body) throw new Error("Storage returned an empty body");

  const out = new Uint8Array(length);
  let filled = 0;
  const reader = res.body.getReader();
  try {
    while (filled < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, length - filled);
      out.set(take === value.byteLength ? value : value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (filled !== length) throw new Error(`Storage returned ${filled} of ${length} requested bytes`);
  return out;
}
