/**
 * The startup hook calls the env check in production (scaling ladder M-5): one warning, never a crash unless
 * ENV_STRICT=1. The check itself is tested in src/server/lib/env-check.test.ts; this proves it is wired in.
 *
 * It edits `process.env` for the length of one test and restores every key it touched.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { register } from "./instrumentation";

const TOUCHED = ["NEXT_RUNTIME", "NODE_ENV", "NEXT_PHASE", "ENV_STRICT", "CRON_SECRET"] as const;
const saved = new Map<string, string | undefined>();
const env = process.env as Record<string, string | undefined>;
let warns: unknown[][] = [];
let spy: { mockRestore: () => void };

beforeEach(() => {
  for (const k of TOUCHED) saved.set(k, env[k]);
  warns = [];
  spy = spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warns.push(a));
});
afterEach(() => {
  spy.mockRestore();
  for (const k of TOUCHED) {
    if (saved.get(k) === undefined) delete env[k];
    else env[k] = saved.get(k);
  }
});

/** A production server with a blank CRON_SECRET; `over` replaces any of the touched keys. */
function production(over: Record<string, string> = {}) {
  delete env.ENV_STRICT;
  delete env.NEXT_PHASE;
  Object.assign(env, { NEXT_RUNTIME: "nodejs", NODE_ENV: "production", CRON_SECRET: "", ...over });
}

describe("register() in production", () => {
  test("logs exactly one warning that names the missing variable, and returns normally", async () => {
    production();
    await register();
    const lines = warns.filter((w) => typeof w[0] === "string" && (w[0] as string).startsWith("[env]"));
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toContain("CRON_SECRET");
  });

  test("ENV_STRICT=1 refuses to start (register rejects) and names the variable", async () => {
    production({ ENV_STRICT: "1" });
    await expect(register()).rejects.toThrow(/CRON_SECRET/);
  });

  test("the build phase is not checked", async () => {
    production({ NEXT_PHASE: "phase-production-build", ENV_STRICT: "1" });
    await register();
    expect(warns).toEqual([]);
  });

  test("another runtime (edge) does nothing", async () => {
    production({ NEXT_RUNTIME: "edge", ENV_STRICT: "1" });
    await register();
    expect(warns).toEqual([]);
  });
});
