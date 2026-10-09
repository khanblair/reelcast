/**
 * Server-side product analytics (PostHog). A strict no-op unless NEXT_PUBLIC_POSTHOG_KEY is set.
 *
 *   NEXT_PUBLIC_POSTHOG_KEY   project API key (shared with the browser provider)
 *   NEXT_PUBLIC_POSTHOG_HOST  optional, default https://eu.i.posthog.com
 *
 * Privacy: callers pass the internal user id as `distinctId` only. Property keys that look like
 * PII or secrets (email, name, token, key, ...) are dropped defensively.
 * Safety: never throws, never blocks for long (request timeout + hard cap on the flush).
 */
import { PostHog } from "posthog-node";

const DEFAULT_HOST = "https://eu.i.posthog.com";
const FLUSH_CAP_MS = 2_000;
/** Words that mark a property as PII or a secret (checked per word: userName, access_token, apiKey ...). */
const BLOCKED_WORDS = new Set(["email", "mail", "name", "token", "secret", "password", "key", "authorization", "cookie", "phone"]);
const isBlockedKey = (k: string) =>
  k
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => BLOCKED_WORDS.has(w));

let client: PostHog | null = null;
let clientKey: string | undefined;

function getClient(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (client && clientKey === key) return client;
  client = new PostHog(key, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_HOST,
    // Serverless: send each event right away rather than relying on a timer.
    flushAt: 1,
    flushInterval: 0,
    requestTimeout: 3_000,
    fetchRetryCount: 0,
    disableGeoip: true,
  });
  clientKey = key;
  return client;
}

export function sanitizeProps(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (isBlockedKey(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/** Capture one server event for `distinctId` (the user id). Resolves quickly and never throws. */
export async function captureServerEvent(
  distinctId: string,
  event: string,
  props?: Record<string, unknown>,
): Promise<void> {
  try {
    const ph = getClient();
    if (!ph || !distinctId || !event) return;
    ph.capture({ distinctId, event, properties: sanitizeProps(props) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      ph.flush().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_CAP_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
  } catch {
    // Analytics must never break a request or a job.
  }
}
