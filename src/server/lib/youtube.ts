/**
 * YouTube Data API v3 helpers used by the publishing runtime.
 *
 * Uploads use the RESUMABLE protocol so a file of any size can be sent in fixed-size chunks
 * across several job runs (a host function lives ~300s and files can reach 2 GB):
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *
 *  1. POST   .../upload/youtube/v3/videos?uploadType=resumable   -> 200 + `Location` (session URI)
 *  2. PUT    <session URI>  Content-Range: bytes a-b/total        -> 308 (+ `Range: bytes=0-N`) | 200/201 (+ video resource)
 *  3. PUT    <session URI>  Content-Range: bytes * /total         -> status query (same answers as step 2)
 *
 * Every function takes the `fetch` implementation as a parameter so tests can mock Google.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PrivacyStatus = "private" | "public" | "unlisted";

export interface YouTubeVideoMetadata {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: PrivacyStatus;
  publishAs?: "short" | "video";
}

const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true";

/** videos.insert costs 1600 quota units (https://developers.google.com/youtube/v3/determine_quota_cost). */
export const YOUTUBE_UPLOAD_QUOTA_UNITS = 1600;
/** channels.list costs 1 unit. */
export const YOUTUBE_CHANNELS_LIST_QUOTA_UNITS = 1;

/** The resumable protocol requires every chunk but the last to be a multiple of 256 KiB. */
export const CHUNK_GRANULARITY = 256 * 1024;

/** 403/400 reasons that are about quota or rate, i.e. may clear on their own (retryable). */
const TRANSIENT_REASONS = new Set([
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "uploadLimitExceeded",
  "backendError",
  "internalError",
  "serviceUnavailable",
]);

/** A non-success answer from Google, classified so the job layer knows whether a retry can help. */
export class YouTubeApiError extends Error {
  readonly status: number;
  /** `error.errors[0].reason` from the Google error envelope, when present. */
  readonly reason: string | null;
  readonly retryable: boolean;
  constructor(message: string, status: number, reason: string | null, retryable: boolean) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
  }
}

type GoogleErrorBody = { error?: { code?: number; message?: string; errors?: { reason?: string; message?: string }[] } | string; error_description?: string };

function parseGoogleError(text: string): { reason: string | null; message: string } {
  try {
    const body = JSON.parse(text) as GoogleErrorBody;
    if (typeof body.error === "object" && body.error) {
      return { reason: body.error.errors?.[0]?.reason ?? null, message: body.error.message ?? text };
    }
    if (typeof body.error === "string") return { reason: body.error, message: body.error_description ?? body.error };
  } catch {
    // not JSON
  }
  return { reason: null, message: text };
}

/**
 * Decide whether a Google HTTP failure can succeed on a later attempt, from the status and
 * the structured reason (never from message text):
 *  - 5xx, 408, 429                         retryable (server / throttling)
 *  - 401                                   retryable (the next attempt mints a fresh token; a revoked
 *                                          grant is caught by getValidAccessToken and stops there)
 *  - 4xx with a quota/rate reason          retryable
 *  - anything else (400 invalid metadata, 403 forbidden, 404 ...)  permanent
 */
export function classifyYouTubeFailure(status: number, bodyText: string, label: string): YouTubeApiError {
  const { reason, message } = parseGoogleError(bodyText);
  const retryable =
    status >= 500 || status === 408 || status === 429 || status === 401 || (reason !== null && TRANSIENT_REASONS.has(reason));
  const detail = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  return new YouTubeApiError(`${label}: ${detail || `HTTP ${status}`}`, status, reason, retryable);
}

const withTimeout = (ms: number) => AbortSignal.timeout(ms);

// ─── OAuth ───────────────────────────────────────────────────────────────────

export async function refreshYouTubeToken(
  refreshToken: string,
  f: FetchLike = (i, o) => fetch(i, o),
): Promise<{ accessToken: string; expiresIn: number }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured on the server");

  const response = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: withTimeout(15_000),
  });

  if (!response.ok) {
    throw classifyYouTubeFailure(response.status, await response.text(), "YouTube token refresh failed");
  }

  const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string") throw new Error("YouTube token refresh returned no access token");
  return { accessToken: data.access_token, expiresIn: typeof data.expires_in === "number" ? data.expires_in : 3600 };
}

/** Cheap authenticated probe (channels.list, 1 unit): does this access token still work? */
export async function probeChannelAccess(accessToken: string, f: FetchLike = (i, o) => fetch(i, o)): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await f(CHANNELS_URL, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: withTimeout(15_000) });
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ─── resumable upload ────────────────────────────────────────────────────────

/** Start an upload session. Returns the session URI (valid for resuming from any later run). */
export async function initiateResumableUpload(
  f: FetchLike,
  args: { accessToken: string; metadata: YouTubeVideoMetadata; totalSize: number },
): Promise<string> {
  const { accessToken, metadata, totalSize } = args;
  // A regular (non-Short) video must not carry #Shorts, or YouTube classifies it as a Short
  // and applies different Content ID rules.
  const description =
    metadata.publishAs === "video" ? metadata.description.replace(/#Shorts\s*/gi, "").trim() : metadata.description;

  const res = await f(UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/*",
      "X-Upload-Content-Length": String(totalSize),
    },
    body: JSON.stringify({
      snippet: { title: metadata.title, description, tags: metadata.tags, categoryId: "22" /* People & Blogs */ },
      status: { privacyStatus: metadata.privacyStatus },
    }),
    signal: withTimeout(30_000),
  });

  if (!res.ok) throw classifyYouTubeFailure(res.status, await res.text(), "YouTube upload initiation failed");
  const location = res.headers.get("Location");
  await res.body?.cancel().catch(() => undefined);
  if (!location) throw new YouTubeApiError("YouTube did not return an upload URL", res.status, null, true);
  return location;
}

export type ResumableStatus =
  | { kind: "incomplete"; offset: number }
  | { kind: "done"; videoId: string }
  | { kind: "expired" };

/** `Range: bytes=0-N` => N+1 bytes are stored; a missing header means nothing is stored yet. */
export function parseReceivedOffset(rangeHeader: string | null): number {
  if (!rangeHeader) return 0;
  const m = /bytes=\d+-(\d+)/.exec(rangeHeader);
  return m ? Number(m[1]) + 1 : 0;
}

async function readVideoId(res: Response): Promise<string> {
  let body: { id?: unknown } = {};
  try {
    body = (await res.json()) as { id?: unknown };
  } catch {
    // fall through
  }
  if (typeof body.id !== "string" || !body.id) {
    throw new YouTubeApiError("YouTube did not return a video ID", res.status, null, true);
  }
  return body.id;
}

async function interpret(res: Response, label: string): Promise<ResumableStatus> {
  if (res.status === 308) {
    const offset = parseReceivedOffset(res.headers.get("Range"));
    await res.body?.cancel().catch(() => undefined);
    return { kind: "incomplete", offset };
  }
  if (res.status === 200 || res.status === 201) return { kind: "done", videoId: await readVideoId(res) };
  // The session URI no longer exists (expired/finished long ago): the caller restarts from byte 0.
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "expired" };
  }
  throw classifyYouTubeFailure(res.status, await res.text(), label);
}

/**
 * Ask Google how much of the upload it has. Authoritative: callers trust this over any stored
 * counter. A finished upload answers 200/201 with the video resource (=> `done`).
 */
export async function queryResumableUpload(
  f: FetchLike,
  args: { sessionUri: string; totalSize: number; accessToken: string },
): Promise<ResumableStatus> {
  const res = await f(args.sessionUri, {
    method: "PUT",
    headers: { Authorization: `Bearer ${args.accessToken}`, "Content-Length": "0", "Content-Range": `bytes */${args.totalSize}` },
    redirect: "manual", // a 308 must be read, never followed
    signal: withTimeout(30_000),
  });
  return interpret(res, "YouTube upload status check failed");
}

/** Send bytes [start, start + chunk.length) of the file. */
export async function putResumableChunk(
  f: FetchLike,
  args: { sessionUri: string; accessToken: string; chunk: Uint8Array; start: number; totalSize: number; timeoutMs: number },
): Promise<ResumableStatus> {
  const { chunk, start, totalSize } = args;
  const res = await f(args.sessionUri, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "video/*",
      "Content-Length": String(chunk.byteLength),
      "Content-Range": `bytes ${start}-${start + chunk.byteLength - 1}/${totalSize}`,
    },
    body: chunk as unknown as BodyInit,
    redirect: "manual",
    signal: withTimeout(args.timeoutMs),
  });
  return interpret(res, "YouTube video upload failed");
}

/**
 * True when a failed chunk PUT left the outcome unknown (network cut, timeout, 5xx): the caller
 * re-queries the session before resuming. Any non-API error from `fetch` itself (rejections are
 * network failures, aborts or timeouts) counts; a classified 4xx never does.
 */
export function isTransientUploadFailure(e: unknown): boolean {
  if (e instanceof YouTubeApiError) return e.status >= 500 || e.status === 0;
  return e instanceof Error;
}
