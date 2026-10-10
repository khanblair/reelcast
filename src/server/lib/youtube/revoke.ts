import type { FetchLike } from "../youtube";

/**
 * Tell Google a stored token is no longer wanted, so the app disappears from the user's Google account permissions.
 * Google answers 400 `invalid_token` for a token that is already revoked or expired; that is the outcome we wanted,
 * so it is not an error. Anything else (network, 5xx) throws and the caller decides whether that matters.
 */
export async function revokeGoogleToken(token: string, f: FetchLike = (i, o) => fetch(i, o)): Promise<void> {
  const res = await f("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return;
  const text = await res.text();
  if (res.status === 400 && text.includes("invalid_token")) return;
  throw new Error(`Google token revoke failed: ${res.status}`);
}
