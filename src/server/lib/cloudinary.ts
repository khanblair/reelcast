import { createHash } from "node:crypto";
import type { FetchLike } from "./youtube";

/**
 * Video files live on Cloudinary and `raw_file_key` / `processed_file_key` are written by the
 * client or by our own generation pipeline. The server fetches them (HEAD, range GETs piped to
 * YouTube), so only Cloudinary's delivery host over https is ever allowed: anything else would
 * let a crafted key make the server request an internal address (SSRF).
 */
const ALLOWED_MEDIA_HOST = "res.cloudinary.com";

export function isAllowedMediaUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== ALLOWED_MEDIA_HOST || u.username !== "" || u.password !== "" || u.port !== "") return false;
    // Only OUR Cloudinary account: a key pointing at someone else's cloud must neither be published nor "cleaned up".
    const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    return !cloud || u.pathname.startsWith(`/${cloud}/`);
  } catch {
    return false;
  }
}

export function extractCloudinaryPublicId(url: string): string | null {
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  if (!match) return null;
  // Strip trailing file extension if present (e.g. .mp4), but keep folder separators
  return match[1].replace(/\.[^./]+$/, "");
}

function credentials(): { cloudName: string; apiKey: string; apiSecret: string } {
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Cloudinary credentials not configured");
  return { cloudName, apiKey, apiSecret };
}

export async function destroyCloudinaryAsset(
  publicId: string,
  resourceType: "video" | "image" = "video",
  f: FetchLike = (i, o) => fetch(i, o),
): Promise<void> {
  const { cloudName, apiKey, apiSecret } = credentials();

  const timestamp = Math.floor(Date.now() / 1000);
  const signatureStr = `public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash("sha1").update(signatureStr).digest("hex");

  const formData = new FormData();
  formData.append("public_id", publicId);
  formData.append("timestamp", timestamp.toString());
  formData.append("signature", signature);
  formData.append("api_key", apiKey);

  const res = await f(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cloudinary destroy failed: ${res.status} — ${body}`);
  }
}

// ─── durations (Admin API) ───────────────────────────────────────────────────

type CloudinaryResource = { public_id?: string; duration?: number };

function authHeader(): { Authorization: string } {
  const { apiKey, apiSecret } = credentials();
  return { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}` };
}

// ─── bulk delete + image info (Admin API) ────────────────────────────────────

export type CloudinaryResourceType = "video" | "image";

const BULK_DELETE_BATCH = 100;
const BULK_DELETE_ATTEMPTS = 3;

/** "deleted" and "not_found" both mean the asset is gone, which is all a cleanup needs. */
const isGone = (state: unknown) => state === "deleted" || state === "not_found";

type BulkDeleteResponse = { deleted?: Record<string, string>; partial?: boolean };

/**
 * Delete assets by public id with the Admin API (100 per call, CDN copies invalidated). Idempotent: an id that is
 * already gone counts as deleted. Throws if any asset could not be confirmed gone, or when `deadline` passes, so a
 * caller can refuse to go on and a retry simply picks up the rest.
 */
export async function destroyCloudinaryAssets(
  publicIds: string[],
  resourceType: CloudinaryResourceType,
  opts: { f?: FetchLike; deadline?: number } = {},
): Promise<void> {
  const ids = [...new Set(publicIds)];
  if (ids.length === 0) return;
  const f = opts.f ?? ((i: string | URL | Request, o?: RequestInit) => fetch(i, o));
  const { cloudName } = credentials();
  const headers = authHeader();

  for (let i = 0; i < ids.length; i += BULK_DELETE_BATCH) {
    let remaining = ids.slice(i, i + BULK_DELETE_BATCH);
    for (let attempt = 0; attempt < BULK_DELETE_ATTEMPTS && remaining.length > 0; attempt++) {
      if (opts.deadline !== undefined && Date.now() > opts.deadline) throw new Error("Cloudinary cleanup ran out of time");
      const url = new URL(`https://api.cloudinary.com/v1_1/${cloudName}/resources/${resourceType}/upload`);
      for (const id of remaining) url.searchParams.append("public_ids[]", id);
      url.searchParams.set("invalidate", "true");
      const res = await f(url, { method: "DELETE", headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Cloudinary bulk delete failed: ${res.status} — ${await res.text()}`);
      const body = (await res.json()) as BulkDeleteResponse;
      remaining = remaining.filter((id) => !isGone(body.deleted?.[id]));
    }
    if (remaining.length > 0) throw new Error(`Cloudinary could not delete ${remaining.length} asset(s)`);
  }
}

/** Delete every asset whose public id starts with `prefix` (the Admin API pages through `partial` responses). */
export async function destroyCloudinaryPrefix(
  prefix: string,
  resourceType: CloudinaryResourceType,
  opts: { f?: FetchLike; deadline?: number } = {},
): Promise<void> {
  if (!prefix.endsWith("/") || prefix.length < 4) throw new Error("Refusing to delete by a short or open-ended prefix");
  const f = opts.f ?? ((i: string | URL | Request, o?: RequestInit) => fetch(i, o));
  const { cloudName } = credentials();
  const headers = authHeader();

  for (let round = 0; round < 10; round++) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) throw new Error("Cloudinary cleanup ran out of time");
    const url = new URL(`https://api.cloudinary.com/v1_1/${cloudName}/resources/${resourceType}/upload`);
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("invalidate", "true");
    const res = await f(url, { method: "DELETE", headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Cloudinary prefix delete failed: ${res.status} — ${await res.text()}`);
    const body = (await res.json()) as BulkDeleteResponse;
    if (!body.partial) return;
  }
  throw new Error("Cloudinary prefix delete did not finish");
}

export type CloudinaryImageInfo = { resourceType: string; type: string; format: string; bytes: number; width: number; height: number };

/** Facts about an uploaded image, or null when Cloudinary does not know the public id. */
export async function getCloudinaryImageInfo(publicId: string, f: FetchLike = (i, o) => fetch(i, o)): Promise<CloudinaryImageInfo | null> {
  const { cloudName } = credentials();
  const path = publicId.split("/").map(encodeURIComponent).join("/");
  const res = await f(`https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload/${path}`, {
    headers: authHeader(),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) throw new Error(`Cloudinary lookup failed: ${res.status}`);
  const r = (await res.json()) as Record<string, unknown>;
  return {
    resourceType: String(r.resource_type ?? ""),
    type: String(r.type ?? ""),
    format: String(r.format ?? "").toLowerCase(),
    bytes: Number(r.bytes ?? 0),
    width: Number(r.width ?? 0),
    height: Number(r.height ?? 0),
  };
}


const usableDuration = (d: unknown): number | null => (typeof d === "number" && Number.isFinite(d) && d > 0 ? Math.round(d) : null);

/**
 * Durations (whole seconds) for the given public ids. One bulk Admin API call per 100 ids, then a
 * per-resource lookup for any id the bulk response returned without a duration. Ids Cloudinary
 * does not know are simply absent from the map. Stops early (returning what it has) at `deadline`.
 */
export async function fetchCloudinaryDurations(
  publicIds: string[],
  opts: { f?: FetchLike; deadline?: number; concurrency?: number } = {},
): Promise<Map<string, number>> {
  const f = opts.f ?? ((i: string | URL | Request, o?: RequestInit) => fetch(i, o));
  const { cloudName } = credentials();
  const headers = authHeader();
  const out = new Map<string, number>();
  const timeLeft = () => (opts.deadline ?? Number.POSITIVE_INFINITY) - Date.now() > 0;

  for (let i = 0; i < publicIds.length && timeLeft(); i += 100) {
    const slice = publicIds.slice(i, i + 100);
    const url = new URL(`https://api.cloudinary.com/v1_1/${cloudName}/resources/video/upload`);
    for (const id of slice) url.searchParams.append("public_ids[]", id);
    url.searchParams.set("max_results", "100");
    try {
      const res = await f(url, { headers, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const data = (await res.json()) as { resources?: CloudinaryResource[] };
      for (const r of data.resources ?? []) {
        const d = usableDuration(r.duration);
        if (r.public_id && d) out.set(r.public_id, d);
      }
    } catch {
      // fall through to per-resource lookups
    }
  }

  // The bulk listing may omit video details; the single-resource endpoint always includes them.
  const missing = publicIds.filter((id) => !out.has(id));
  const concurrency = opts.concurrency ?? 5;
  for (let i = 0; i < missing.length && timeLeft(); i += concurrency) {
    await Promise.allSettled(
      missing.slice(i, i + concurrency).map(async (id) => {
        const path = id.split("/").map(encodeURIComponent).join("/");
        const res = await f(`https://api.cloudinary.com/v1_1/${cloudName}/resources/video/upload/${path}`, {
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          return;
        }
        const d = usableDuration(((await res.json()) as CloudinaryResource).duration);
        if (d) out.set(id, d);
      }),
    );
  }
  return out;
}
