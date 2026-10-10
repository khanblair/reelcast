/**
 * /auth/callback must never send the browser to another origin, whatever `next` says.
 * The Supabase client is mocked (the real one needs a request scope); everything else is the real route.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const ORIGIN = "https://app.test";

let exchangeResult: { error: Error | null } = { error: null };
const exchangeCalls: string[] = [];

type ServerModule = typeof import("@/lib/supabase/server");
let realServerModule: ServerModule;
let GET: (request: Request) => Promise<Response>;

beforeAll(async () => {
  realServerModule = await import("@/lib/supabase/server");
  mock.module("@/lib/supabase/server", () => ({
    createClient: async () => ({
      auth: {
        exchangeCodeForSession: async (code: string) => {
          exchangeCalls.push(code);
          return exchangeResult;
        },
      },
    }),
  }));
  ({ GET } = await import("./route"));
});

afterAll(() => {
  // mock.module is process-wide: put the real module back for any test file that runs after this one.
  mock.module("@/lib/supabase/server", () => realServerModule);
});

beforeEach(() => {
  exchangeResult = { error: null };
  exchangeCalls.length = 0;
});

const callback = (query: Record<string, string>) => GET(new Request(`${ORIGIN}/auth/callback?${new URLSearchParams(query).toString()}`));
const location = (res: Response) => res.headers.get("location") ?? "";

describe("GET /auth/callback", () => {
  const hostile = [
    "@evil.com", //                 https://app.test@evil.com -> userinfo trick, host evil.com
    ".evil.com", //                 https://app.test.evil.com
    ":8080@evil.com",
    "//evil.com",
    "/\\evil.com",
    "/.//evil.com", //              normalises to //evil.com
    "/a/..//evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "\t//evil.com",
    "/\t/evil.com", //              the URL parser strips the tab: //evil.com
    "/\n/evil.com",
  ];

  for (const next of hostile) {
    test(`hostile next ${JSON.stringify(next)} falls back to /dashboard on our own origin`, async () => {
      const res = await callback({ code: "good", next });
      expect(res.status).toBeGreaterThanOrEqual(300);
      expect(res.status).toBeLessThan(400);
      expect(new URL(location(res)).host).toBe("app.test");
      expect(location(res)).toBe(`${ORIGIN}/dashboard`);
      expect(exchangeCalls).toEqual(["good"]); // the code is still exchanged: only the destination is distrusted
    });
  }

  test("a same-origin next survives, with its query and hash", async () => {
    const res = await callback({ code: "good", next: "/billing?status=ok#plans" });
    expect(location(res)).toBe(`${ORIGIN}/billing?status=ok#plans`);
  });

  test("no next goes to /dashboard", async () => {
    expect(location(await callback({ code: "good" }))).toBe(`${ORIGIN}/dashboard`);
  });

  test("a missing code or a failed exchange never follows next", async () => {
    expect(location(await callback({ next: "/billing" }))).toBe(`${ORIGIN}/sign-in?error=auth`);
    exchangeResult = { error: new Error("bad code") };
    expect(location(await callback({ code: "bad", next: "@evil.com" }))).toBe(`${ORIGIN}/sign-in?error=auth`);
  });
});
