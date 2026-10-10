import { describe, expect, test } from "bun:test";
import { safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  const FALLBACK = "/dashboard";

  // [label, input, expected]
  const cases: [string, string | null | undefined, string][] = [
    // Attacks: all must collapse to the fallback.
    ["userinfo trick", "@evil.com", FALLBACK],
    ["userinfo with port", ":8080@evil.com", FALLBACK],
    ["subdomain glue", ".evil.com", FALLBACK],
    ["scheme-relative", "//evil.com", FALLBACK],
    ["scheme-relative with path", "//evil.com/dashboard", FALLBACK],
    ["backslash host", "/\\evil.com", FALLBACK],
    ["backslash anywhere", "/ok\\path", FALLBACK],
    ["absolute https", "https://evil.com", FALLBACK],
    ["absolute http", "http://evil.com/dashboard", FALLBACK],
    ["absolute to our own host is still not a path", "https://same-origin.test/dashboard", FALLBACK],
    ["javascript url", "javascript:alert(1)", FALLBACK],
    ["data url", "data:text/html,<script>1</script>", FALLBACK],
    ["leading tab", "\t//evil.com", FALLBACK],
    ["tab inside the slashes (parser strips it)", "/\t/evil.com", FALLBACK],
    ["newline inside the slashes", "/\n/evil.com", FALLBACK],
    ["carriage return", "/\r/evil.com", FALLBACK],
    ["NUL byte", "/a\u0000b", FALLBACK],
    ["DEL", "/a\u007fb", FALLBACK],
    ["leading space", " /dashboard", FALLBACK],
    ["dot segments normalise to //", "/.//evil.com", FALLBACK],
    ["parent segments normalise to //", "/a/..//evil.com", FALLBACK],
    ["relative path without slash", "dashboard", FALLBACK],
    ["query only", "?next=/x", FALLBACK],
    ["empty", "", FALLBACK],
    ["null", null, FALLBACK],
    ["undefined", undefined, FALLBACK],

    // Allowed: same-origin paths come back intact.
    ["plain path", "/billing", "/billing"],
    ["root", "/", "/"],
    ["query and hash are preserved", "/dashboard?x=1#y", "/dashboard?x=1#y"],
    ["encoded slashes are a path, not a host", "/%2F%2Fevil.com", "/%2F%2Fevil.com"],
    ["encoded backslash is a path", "/%5Cevil.com", "/%5Cevil.com"],
    ["nested path", "/video/abc-123/edit", "/video/abc-123/edit"],
    ["dot segments are resolved", "/a/./b/../c", "/a/c"],
    ["a redirect param inside the query stays inside the query", "/sign-in?redirect_url=https://evil.com", "/sign-in?redirect_url=https://evil.com"],
    ["unicode path is percent-encoded by the parser", "/café", "/caf%C3%A9"],
  ];

  for (const [label, input, expected] of cases) {
    test(`${label}: ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(safeNextPath(input)).toBe(expected);
    });
  }

  test("the fallback is configurable", () => {
    expect(safeNextPath("//evil.com", "/settings")).toBe("/settings");
    expect(safeNextPath(null, "/")).toBe("/");
    expect(safeNextPath("/billing", "/settings")).toBe("/billing");
  });

  test("whatever comes out is safe to hand to a browser: starts with a single slash and resolves on the same origin", () => {
    const hostile = ["@evil.com", "//evil.com", "/\\evil.com", "/.//evil.com", "/a/..//evil.com", "https://evil.com", "\t//evil.com", "/%2F%2Fevil.com", "/x"];
    for (const input of hostile) {
      const out = safeNextPath(input);
      expect(out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
      expect(new URL(out, "https://app.test").origin).toBe("https://app.test");
    }
  });
});
