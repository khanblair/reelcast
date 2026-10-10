/**
 * What POST /api/rpc checks before it will look at a request's content (scaling ladder R-5). Pure functions on a
 * `Request`, so they are tested without a session or a database.
 *
 *  1. `Sec-Fetch-Site`: browsers say whether the request came from this site. Anything but same-origin / none is refused.
 *  2. `Origin`: when present it must be one of OUR hosts (see `originIsOurs`). Old browsers and non-browser clients that
 *     send neither header are let through here; the session cookie (SameSite) is the next line of defence.
 *  3. `Content-Type` must be `application/json`, nothing else. A "simple" cross-site form post cannot send it.
 *  4. The body is at most `RPC_MAX_BODY_BYTES`, checked from `Content-Length` first and again while the stream is read
 *     (the header can be absent or false), so a huge body is never held in memory.
 */

/**
 * 1 MiB, the same default Next.js applies to Server Action bodies. The largest legitimate call is the contact form
 * (50,000-character message plus three 5,000-character fields: about 65 KB, 390 KB if every character needed a
 * `\u00XX` escape); `queue.reorder` with its 1,000 entries is about 80 KB. Captions (up to 200,000 characters) are
 * produced and stored on the server and are never sent back by the browser.
 */
export const RPC_MAX_BODY_BYTES = 1024 * 1024;

export type RpcRefusalCode = "FORBIDDEN" | "BAD_REQUEST" | "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE";
export type Refusal = { status: number; code: RpcRefusalCode; message: string };

const crossSite: Refusal = { status: 403, code: "FORBIDDEN", message: "Cross-site request blocked" };
const crossOrigin: Refusal = { status: 403, code: "FORBIDDEN", message: "Cross-origin request blocked" };
const notJson: Refusal = { status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Expected application/json" };
const tooLarge: Refusal = { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body too large" };
const invalidJson: Refusal = { status: 400, code: "BAD_REQUEST", message: "Invalid JSON" };

/** `application/json`, any letter case, with at most a `charset=utf-8` parameter. `text/plain;application/json` is not JSON. */
export function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const [type, ...params] = value.split(";");
  if (type.trim().toLowerCase() !== "application/json") return false;
  if (params.length === 0) return true;
  return params.length === 1 && /^\s*charset\s*=\s*(?:utf-8|"utf-8")\s*$/i.test(params[0]);
}

/** A bare `host` or `host:port` (what the Host / X-Forwarded-Host headers carry). Anything else is not trusted. */
const HOST_LIKE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** `host[:port]` with the default port of `protocol` removed and letters lower-cased, or null if it is not a host. */
function normalizeHost(raw: string, protocol: string): string | null {
  const value = raw.trim();
  if (!HOST_LIKE.test(value)) return null;
  try {
    return new URL(`${protocol}//${value}`).host;
  } catch {
    return null;
  }
}

/**
 * Is this request's `Origin` one of our own hosts? An absent header is true (see the file header); a present header
 * that is empty, `null`, unparseable or not http(s) is false.
 *
 * Only the HOST (name and port) is compared, never the scheme: TLS is usually ended in front of the app, so `req.url`
 * may say `http://` while the browser's Origin says `https://`. This is the rule Next.js itself applies to Server
 * Actions (Origin against Host or X-Forwarded-Host). Our hosts are, after normalising:
 *   - the first `X-Forwarded-Host` (the public name behind a proxy),
 *   - the `Host` header (the deployment's own domain, preview deployments included),
 *   - the host of the request URL,
 *   - the host of `NEXT_PUBLIC_APP_URL`, for a proxy that rewrites both headers.
 * A cross-site page cannot set any of those request headers; the browser fixes `Origin` to the page's own origin.
 */
export function originIsOurs(req: Request, appUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL): boolean {
  const header = req.headers.get("origin");
  if (header === null) return true;

  let origin: URL;
  try {
    origin = new URL(header);
  } catch {
    return false;
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return false;

  const candidates: (string | null)[] = [req.headers.get("x-forwarded-host")?.split(",")[0] ?? null, req.headers.get("host")];
  for (const full of [req.url, appUrl]) {
    try {
      if (full) candidates.push(new URL(full).host);
    } catch {
      // An unparseable URL contributes nothing.
    }
  }
  return candidates.some((c) => c !== null && normalizeHost(c, origin.protocol) === origin.host);
}

/** Everything that can be decided from the headers alone. `null` means "go on and read the body". */
export function checkRpcHeaders(req: Request, maxBytes: number = RPC_MAX_BODY_BYTES): Refusal | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return crossSite;
  if (!originIsOurs(req)) return crossOrigin;
  if (!isJsonContentType(req.headers.get("content-type"))) return notJson;
  // Only a clean integer is believed; anything else is left to the stream cap in readJsonBody.
  const length = req.headers.get("content-length")?.trim();
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) return tooLarge;
  return null;
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; refusal: Refusal };

/**
 * Read and parse the JSON body, giving up as soon as more than `maxBytes` bytes (not characters) have arrived. The
 * stream is cancelled at that point, so an endless body costs at most one extra chunk. An empty body, an unreadable
 * stream (the client hung up) and malformed JSON are all "Invalid JSON", as before.
 */
export async function readJsonBody(req: Request, maxBytes: number = RPC_MAX_BODY_BYTES): Promise<JsonBody> {
  if (req.body === null) return { ok: false, refusal: invalidJson };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Not awaited: telling a slow client's connection to stop must not hold this response up.
        reader.cancel().catch(() => undefined);
        return { ok: false, refusal: tooLarge };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, refusal: invalidJson };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, refusal: invalidJson };
  }
}
