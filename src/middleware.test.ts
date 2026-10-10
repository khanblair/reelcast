import { beforeEach, describe, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";

// The Supabase client is replaced so the test sees exactly which auth call the middleware makes.
const getClaims = mock(async (): Promise<unknown> => ({ data: { claims: { sub: "user-1" } }, error: null }));
const getUser = mock(async (): Promise<unknown> => ({ data: { user: { id: "user-1" } }, error: null }));
mock.module("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims, getUser } }),
}));
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";

const { middleware } = await import("./middleware");

const request = (path: string) => new NextRequest(new URL(path, "https://app.example.test"));

beforeEach(() => {
  getClaims.mockClear();
  getUser.mockClear();
  getClaims.mockImplementation(async () => ({ data: { claims: { sub: "user-1" } }, error: null }));
});

describe("middleware auth check", () => {
  test("verifies the session with getClaims() and never asks Supabase Auth with getUser()", async () => {
    await middleware(request("/dashboard"));
    expect(getClaims).toHaveBeenCalledTimes(1);
    expect(getUser).not.toHaveBeenCalled();
  });

  test("a signed-in visitor reaches a protected page, which is marked no-store", async () => {
    const res = await middleware(request("/dashboard"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a signed-out visitor on a protected page is redirected to sign-in, remembering where they were going", async () => {
    getClaims.mockImplementation(async () => ({ data: null, error: null }));
    const res = await middleware(request("/billing"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("redirect_url")).toBe("/billing");
  });

  test("an invalid or expired token (getClaims error) counts as signed out", async () => {
    getClaims.mockImplementation(async () => ({ data: null, error: { name: "AuthInvalidJwtError", message: "Invalid JWT signature" } }));
    const res = await middleware(request("/admin/users"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
  });

  test("claims without a subject do not count as signed in", async () => {
    getClaims.mockImplementation(async () => ({ data: { claims: {} }, error: null }));
    const res = await middleware(request("/dashboard"));
    expect(res.status).toBe(307);
  });

  test("a public page is never redirected and is not marked no-store", async () => {
    getClaims.mockImplementation(async () => ({ data: null, error: null }));
    const res = await middleware(request("/pricing"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  test("a path that only starts like a protected one is not protected", async () => {
    getClaims.mockImplementation(async () => ({ data: null, error: null }));
    const res = await middleware(request("/dashboardx"));
    expect(res.status).toBe(200);
  });
});
