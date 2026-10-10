/**
 * Post-login redirects: accept a same-origin PATH, never a URL.
 *
 * A destination that arrives in a query string (`?next=`, `?redirect_url=`) is attacker-controlled. Gluing it onto
 * the origin (`${origin}${next}`) lets `@evil.com` become `https://our-host@evil.com`, and handing it to
 * `router.push` / `Location` lets `//evil.com` or `/\evil.com` leave the site. `safeNextPath` returns a path that is
 * safe to use in either place, or the fallback.
 */

// Any origin works: the helper only compares "does this still resolve against the same origin".
const PROBE_ORIGIN = "https://same-origin.test";

// C0 controls (tab, CR and LF included), DEL and backslash. The URL parser silently deletes tab/CR/LF and turns a
// backslash into a slash, which is how `/\t/evil.com` and `/\evil.com` become `//evil.com`; reject them up front.
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * Return `next` (pathname + search + hash) when it is a same-origin relative path, else `fallback`.
 *
 * Accepted: starts with exactly one `/` and still resolves to the same origin after URL normalisation.
 * Rejected: null/empty, absolute URLs (`https://…`, `javascript:…`), anything not starting with `/` (`@evil.com`,
 * `.evil.com`), `//host`, any backslash or control character, and paths that NORMALISE to `//…` (`/.//evil.com`).
 *
 * `fallback` must be a trusted constant: it is returned as is.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (typeof next !== "string" || next === "") return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  if (FORBIDDEN_CHARS.test(next)) return fallback;

  let url: URL;
  try {
    url = new URL(next, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;

  const path = url.pathname + url.search + url.hash;
  // Dot segments are resolved by the parser: `/.//evil.com` and `/a/..//evil.com` come out as `//evil.com`, which a
  // browser reads as a scheme-relative URL.
  if (path.startsWith("//")) return fallback;
  return path;
}
