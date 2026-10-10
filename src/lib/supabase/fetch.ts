/**
 * A `fetch` that gives up after a deadline, for the Supabase clients' `global.fetch` option.
 *
 * Without it a stalled Auth request (`getClaims()` falling back to `getUser()`, a token refresh, the OAuth
 * code exchange) holds the whole serverless function until the host kills it at maxDuration.
 *
 * auth-js turns any rejection of `fetch` into an `AuthRetryableFetchError` and returns it as `{ error }`;
 * that kind of error never clears the stored session, so a timeout behaves exactly like a 5xx from Auth
 * does today: this one request is treated as signed out and the next one starts clean.
 *
 * Only web-standard APIs are used (no Node imports). Not verified on the Edge runtime: `AbortSignal.any`, which
 * is only reached when a caller passes its own signal (auth-js passes none today).
 */

/**
 * Normal Auth latency is a few hundred ms (up to ~1 s cross-region), so 10 s only ever fires on a stalled
 * connection. The one unlucky case is a token refresh that Supabase completed but whose answer was lost:
 * the rotated refresh token is never stored and the old one stays usable only for GoTrue's reuse window.
 */
export const SUPABASE_AUTH_TIMEOUT_MS = 10_000;

export function fetchWithTimeout(timeoutMs: number = SUPABASE_AUTH_TIMEOUT_MS): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    // AbortSignal.timeout also covers reading the body, and keeps no timer alive after the request ends.
    const timeout = AbortSignal.timeout(timeoutMs);
    // Never discard a caller's own signal (init wins over the Request's, as in fetch itself).
    const own = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
    return fetch(input, { ...init, signal: own ? AbortSignal.any([own, timeout]) : timeout });
  }) as typeof fetch;
}
