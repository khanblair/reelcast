import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { fetchWithTimeout } from "./fetch";

/**
 * Server-side Supabase client (Auth only: data goes through Drizzle). Every Auth request is bounded by
 * `authTimeoutMs` (default SUPABASE_AUTH_TIMEOUT_MS) so a stalled one cannot hold the function until maxDuration.
 * A timeout comes back as a retryable auth error, like a 5xx from Auth (see ./fetch.ts).
 *
 * `src/middleware.ts` builds its own client and is not covered by this.
 */
export async function createClient(opts: { authTimeoutMs?: number } = {}) {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: fetchWithTimeout(opts.authTimeoutMs) },
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(toSet) {
          try {
            toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {}
        },
      },
    }
  );
}
