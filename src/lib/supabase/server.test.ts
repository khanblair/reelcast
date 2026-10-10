/**
 * Q-4: the server-side Supabase client must not hang on a stalled Auth request. No database and no real
 * network: a fake GoTrue on 127.0.0.1 either never answers (the call must come back with a RETRYABLE auth
 * error within the timeout) or answers normally (the success path must be unchanged).
 *
 * `next/headers` is replaced (there is no request scope in a test); everything else is the real
 * `createClient()` from ./server wired to the real @supabase/ssr and auth-js.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { jsonResponse, never, setEnv, settle, startFakeServer, type FakeServer } from "@/lib/testing/fakeServer";

type Cookie = { name: string; value: string };
let cookieJar: Cookie[] = [];
const cookieStore = { getAll: () => cookieJar, set: (name: string, value: string) => void cookieJar.push({ name, value }) };
// Bun module mocks are process-wide: put the real module back for whichever test file runs next.
const realHeaders = await import("next/headers");
mock.module("next/headers", () => ({ ...realHeaders, cookies: async () => cookieStore }));
afterAll(() => {
  mock.module("next/headers", () => realHeaders);
});

const { createClient } = await import("./server");

/** A call without a working timeout is still pending after this long. */
const GUARD_MS = 2_500;
const TEST_TIMEOUT_MS = 300;

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const exp = () => Math.floor(Date.now() / 1000) + 3600;
// HS256 on purpose: auth-js cannot verify it locally, so getClaims() falls back to a network getUser().
const accessToken = () => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u1", email: "a@b.co", aud: "authenticated", role: "authenticated", exp: exp() })}.${b64("sig")}`;
const user = { id: "u1", aud: "authenticated", role: "authenticated", email: "a@b.co", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };

// @supabase/ssr names the cookie after the first label of the host: 127.0.0.1 -> "127".
const SESSION_COOKIE = "sb-127-auth-token";
const withSession = () => {
  const session = { access_token: accessToken(), refresh_token: "r1", expires_at: exp(), expires_in: 3600, token_type: "bearer", user };
  cookieJar = [{ name: SESSION_COOKIE, value: `base64-${b64(session)}` }];
};
const withCodeVerifier = () => {
  // auth-js stores the verifier JSON-encoded; @supabase/ssr base64url-encodes cookie values.
  cookieJar = [{ name: `${SESSION_COOKIE}-code-verifier`, value: `base64-${b64(JSON.stringify("verifier-123"))}` }];
};

let server: FakeServer | undefined;
let restoreEnv: () => void;

function serve(handler: Parameters<typeof startFakeServer>[0]): FakeServer {
  server = startFakeServer(handler);
  restoreEnv = setEnv({ NEXT_PUBLIC_SUPABASE_URL: server.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" });
  return server;
}

beforeEach(() => {
  cookieJar = [];
});
afterEach(() => {
  server?.stop();
  server = undefined;
  restoreEnv?.();
});

describe("Supabase Auth on the server", () => {
  test("a hung getClaims() fallback (network getUser) ends in a retryable auth error", async () => {
    const s = serve(never);
    withSession();
    const supabase = await createClient({ authTimeoutMs: TEST_TIMEOUT_MS });
    const out = await settle(() => supabase.auth.getClaims(), GUARD_MS);

    expect(s.hits.map((h) => h.path)).toContain("/auth/v1/user"); // it really reached the fake server
    expect(out.state).toBe("resolved"); // auth-js returns { error }, it does not throw
    if (out.state !== "resolved") return;
    expect(out.elapsedMs).toBeGreaterThanOrEqual(TEST_TIMEOUT_MS - 50);
    expect(out.elapsedMs).toBeLessThan(GUARD_MS);
    expect(out.value.data).toBeNull();
    expect(isAuthRetryableFetchError(out.value.error)).toBe(true); // keeps the session, no sign-out
  });

  test("a hung exchangeCodeForSession() (the OAuth callback) ends in a retryable auth error", async () => {
    const s = serve(never);
    withCodeVerifier();
    const supabase = await createClient({ authTimeoutMs: TEST_TIMEOUT_MS });
    const out = await settle(() => supabase.auth.exchangeCodeForSession("code-1"), GUARD_MS);

    expect(s.hits.map((h) => `${h.method} ${h.path}`)).toContain("POST /auth/v1/token");
    expect(out.state).toBe("resolved");
    if (out.state !== "resolved") return;
    expect(out.elapsedMs).toBeGreaterThanOrEqual(TEST_TIMEOUT_MS - 50);
    expect(out.elapsedMs).toBeLessThan(GUARD_MS);
    expect(out.value.data.session).toBeNull();
    expect(isAuthRetryableFetchError(out.value.error)).toBe(true);
  });

  test("success is unchanged, with the default timeout (10 s) armed on the request", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      serve((hit) =>
        hit.path === "/auth/v1/token"
          ? jsonResponse({ access_token: accessToken(), refresh_token: "r2", expires_in: 3600, token_type: "bearer", user })
          : jsonResponse(user),
      );

      withSession();
      const claims = await (await createClient()).auth.getClaims();
      expect(claims.error).toBeNull();
      expect(claims.data?.claims.sub).toBe("u1");

      withCodeVerifier();
      const exchanged = await (await createClient()).auth.exchangeCodeForSession("code-1");
      expect(exchanged.error).toBeNull();
      expect(exchanged.data.session?.access_token).toBeTruthy();
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seen.length).toBe(2);
    for (const signal of seen) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false); // armed, not fired
    }
  });
});
