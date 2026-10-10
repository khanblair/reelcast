/**
 * Env validation (scaling ladder M-5). Pure tests on synthetic env objects: `process.env` is never passed to an
 * assertion (a failing diff would print it) and no value from the real environment is read.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { encryptSecret } from "@/server/crypto";
import { checkEnv, runStartupEnvCheck, startupEnvReport, type Env } from "./env-check";

const REQUIRED = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "APP_ENCRYPTION_KEY",
  "CRON_SECRET",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
];
const OPTIONAL = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GEMINI_API_KEY", "NEXT_PUBLIC_POSTHOG_KEY"];

const key32 = () => randomBytes(32).toString("base64");

/** A complete, valid environment with synthetic values. */
function goodEnv(over: Env = {}): Env {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pw@db.invalid:6543/postgres",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    APP_ENCRYPTION_KEY: key32(),
    CRON_SECRET: "c".repeat(64),
    NEXT_PUBLIC_APP_URL: "https://app.example.invalid",
    NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "cloud",
    CLOUDINARY_API_KEY: "ck",
    CLOUDINARY_API_SECRET: "cs",
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    GEMINI_API_KEY: "gemini",
    NEXT_PUBLIC_POSTHOG_KEY: "ph",
    ...over,
  };
}

describe("checkEnv", () => {
  test("a complete environment has nothing missing and no warnings", () => {
    expect(checkEnv(goodEnv())).toEqual({ missing: [], warnings: [] });
  });

  for (const name of REQUIRED) {
    test(`${name} unset is reported as missing, and only it`, () => {
      const env = goodEnv();
      delete env[name];
      const r = checkEnv(env);
      expect(r.missing).toEqual([name]);
    });

    test(`${name} empty or whitespace-only counts as missing`, () => {
      for (const blank of ["", " ", "   ", "\t\n", " \n "]) {
        expect(checkEnv(goodEnv({ [name]: blank })).missing).toEqual([name]);
      }
    });
  }

  test("everything missing reports every required name in a stable order and nothing else", () => {
    expect(checkEnv({}).missing).toEqual(REQUIRED);
  });

  test("optional variables only ever warn, one line each, and never count as missing", () => {
    const r = checkEnv(goodEnv({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, GEMINI_API_KEY: undefined, NEXT_PUBLIC_POSTHOG_KEY: " " }));
    expect(r.missing).toEqual([]);
    expect(r.warnings).toHaveLength(OPTIONAL.length);
    for (const name of OPTIONAL) expect(r.warnings.filter((w) => w.startsWith(`${name} `))).toHaveLength(1);
  });

  test("the Gemini warning says the platform key can live in Admin > Settings (platformKeys.ts resolves it first)", () => {
    const [w] = checkEnv(goodEnv({ GEMINI_API_KEY: undefined })).warnings;
    expect(w).toContain("Admin > Settings");
  });

  describe("APP_ENCRYPTION_KEY", () => {
    test("must decode to 32 bytes: 16, 31, 33 and 64 bytes are rejected, 32 is accepted", () => {
      for (const bytes of [0, 1, 16, 31, 33, 64]) {
        const bad = randomBytes(bytes).toString("base64");
        const r = checkEnv(goodEnv({ APP_ENCRYPTION_KEY: bad }));
        expect(r.missing).toEqual(["APP_ENCRYPTION_KEY"]);
      }
      expect(checkEnv(goodEnv({ APP_ENCRYPTION_KEY: key32() })).missing).toEqual([]);
    });

    test("a set-but-bad key is reported as missing AND explained in a warning that carries no value", () => {
      const r = checkEnv(goodEnv({ APP_ENCRYPTION_KEY: "short-not-a-key" }));
      expect(r.missing).toEqual(["APP_ENCRYPTION_KEY"]);
      expect(r.warnings).toEqual([expect.stringContaining("APP_ENCRYPTION_KEY is set but unusable")]);
      expect(JSON.stringify(r)).not.toContain("short-not-a-key");
    });

    test("agrees with crypto.ts: the check passes exactly when encryptSecret can use the key", () => {
      const before = process.env.APP_ENCRYPTION_KEY;
      try {
        const candidates = [key32(), randomBytes(16).toString("base64"), randomBytes(33).toString("base64"), "not base64 at all !!!", "", key32() + "\n", `  ${key32()}`];
        for (const value of candidates) {
          process.env.APP_ENCRYPTION_KEY = value;
          let usable = true;
          try {
            encryptSecret("x");
          } catch {
            usable = false;
          }
          // (whitespace-only is "missing" for the check and "not set / not 32 bytes" for crypto.ts: both unusable)
          expect(checkEnv(goodEnv({ APP_ENCRYPTION_KEY: value })).missing.includes("APP_ENCRYPTION_KEY")).toBe(!usable);
        }
      } finally {
        if (before === undefined) delete process.env.APP_ENCRYPTION_KEY;
        else process.env.APP_ENCRYPTION_KEY = before;
      }
    });
  });

  describe("CRON_SECRET", () => {
    test("shorter than 32 characters is rejected, exactly 32 is accepted", () => {
      expect(checkEnv(goodEnv({ CRON_SECRET: "s".repeat(31) })).missing).toEqual(["CRON_SECRET"]);
      expect(checkEnv(goodEnv({ CRON_SECRET: "s".repeat(32) })).missing).toEqual([]);
    });

    test("padding with spaces does not make a short secret long enough", () => {
      expect(checkEnv(goodEnv({ CRON_SECRET: `short${" ".repeat(60)}` })).missing).toEqual(["CRON_SECRET"]);
    });
  });

  describe("NEXT_PUBLIC_APP_URL", () => {
    test("production needs https", () => {
      expect(checkEnv(goodEnv({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://app.example.invalid" })).missing).toEqual(["NEXT_PUBLIC_APP_URL"]);
      expect(checkEnv(goodEnv({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "https://app.example.invalid" })).missing).toEqual([]);
    });

    test("outside production http://localhost is fine", () => {
      for (const nodeEnv of ["development", "test", undefined]) {
        expect(checkEnv(goodEnv({ NODE_ENV: nodeEnv, NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).missing).toEqual([]);
      }
    });

    test("something that is not a URL is rejected everywhere", () => {
      expect(checkEnv(goodEnv({ NEXT_PUBLIC_APP_URL: "not a url" })).missing).toEqual(["NEXT_PUBLIC_APP_URL"]);
    });
  });

  test("no value, and no fragment of one, appears in the result", () => {
    const secrets = {
      DATABASE_URL: "postgresql://LEAKSENTINEL_USER:LEAKSENTINEL_PASSWORD@host/db",
      NEXT_PUBLIC_SUPABASE_URL: "https://LEAKSENTINEL-supabase.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "LEAKSENTINEL_ANON",
      APP_ENCRYPTION_KEY: "LEAKSENTINEL_KEY", // invalid on purpose
      CRON_SECRET: "LEAKSENTINEL_CRON", // too short on purpose
      NEXT_PUBLIC_APP_URL: "http://LEAKSENTINEL-app.invalid", // http in production on purpose
      NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "LEAKSENTINEL_CLOUD",
      CLOUDINARY_API_KEY: "LEAKSENTINEL_CK",
      CLOUDINARY_API_SECRET: "LEAKSENTINEL_CS",
      GOOGLE_CLIENT_ID: "LEAKSENTINEL_GID",
      GOOGLE_CLIENT_SECRET: "LEAKSENTINEL_GS",
      GEMINI_API_KEY: "LEAKSENTINEL_GEM",
      NEXT_PUBLIC_POSTHOG_KEY: "LEAKSENTINEL_PH",
      ENV_STRICT: "1",
    };
    const env: Env = { NODE_ENV: "production", ...secrets };
    const r = checkEnv(env);
    expect(r.missing).toEqual(["APP_ENCRYPTION_KEY", "CRON_SECRET", "NEXT_PUBLIC_APP_URL"]); // the three invalid ones
    const report = startupEnvReport(env);
    let thrown = "";
    try {
      runStartupEnvCheck(env, () => {});
    } catch (e) {
      thrown = String((e as Error).message) + String((e as Error).stack);
    }
    const everything = JSON.stringify(r) + JSON.stringify(report) + thrown;
    expect(report.fatal).toBe(true);
    expect(thrown).not.toBe("");
    expect(everything).not.toContain("LEAKSENTINEL");
  });
});

describe("startupEnvReport", () => {
  test("nothing missing: no message, not fatal (even under ENV_STRICT=1)", () => {
    expect(startupEnvReport(goodEnv())).toEqual({ message: null, fatal: false });
    expect(startupEnvReport(goodEnv({ ENV_STRICT: "1" }))).toEqual({ message: null, fatal: false });
  });

  test("missing variables are warned about, by name, and are not fatal by default", () => {
    const r = startupEnvReport(goodEnv({ CRON_SECRET: undefined, DATABASE_URL: " " }));
    expect(r.fatal).toBe(false);
    expect(r.message).toContain("DATABASE_URL, CRON_SECRET");
    expect(r.message).toContain("ENV_STRICT=1");
    expect(r.message!.includes("\n")).toBe(false); // one line
  });

  test("ENV_STRICT=1 (exactly) makes it fatal; other values do not", () => {
    const missing = { CRON_SECRET: undefined };
    expect(startupEnvReport(goodEnv({ ...missing, ENV_STRICT: "1" })).fatal).toBe(true);
    for (const v of ["0", "true", "yes", "", " 1", undefined]) expect(startupEnvReport(goodEnv({ ...missing, ENV_STRICT: v })).fatal).toBe(false);
  });

  test("the production build is never checked: it runs without runtime secrets", () => {
    expect(startupEnvReport({ NEXT_PHASE: "phase-production-build", ENV_STRICT: "1" })).toEqual({ message: null, fatal: false });
  });
});

describe("runStartupEnvCheck", () => {
  test("a missing variable produces exactly one warn call, and does not throw", () => {
    const lines: string[] = [];
    runStartupEnvCheck(goodEnv({ CLOUDINARY_API_KEY: undefined, CLOUDINARY_API_SECRET: undefined }), (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET");
  });

  test("a complete environment logs nothing", () => {
    const lines: string[] = [];
    runStartupEnvCheck(goodEnv(), (m) => lines.push(m));
    expect(lines).toEqual([]);
  });

  test("ENV_STRICT=1 with a missing variable throws (naming it) instead of warning", () => {
    const lines: string[] = [];
    expect(() => runStartupEnvCheck(goodEnv({ APP_ENCRYPTION_KEY: undefined, ENV_STRICT: "1" }), (m) => lines.push(m))).toThrow(/APP_ENCRYPTION_KEY/);
    expect(lines).toEqual([]);
  });
});
