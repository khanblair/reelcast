/**
 * The local job runner is opt-in (dev and production may share one database). No database is touched here:
 * env objects are explicit (never `process.env`, which `.env.local` fills in), timers are stubbed, and the
 * scheduled tick callback is captured but never run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { register } from "@/instrumentation";
import { DEV_TICK_OFF_MESSAGE, shouldKick, shouldRunDevTick } from "./dev-tick";
import { kickRunner } from "./kick";

describe("shouldRunDevTick", () => {
  test("runs only in development with DEV_TICK=1", () => {
    expect(shouldRunDevTick({ NODE_ENV: "development", DEV_TICK: "1" })).toBe(true);
  });
  test("development without the opt-in stays off, whatever else is set", () => {
    for (const DEV_TICK of [undefined, "", "0", "true", "yes", "on", " 1", "1 "]) {
      expect(shouldRunDevTick({ NODE_ENV: "development", DEV_TICK })).toBe(false);
    }
  });
  test("never outside development, even with the opt-in", () => {
    for (const NODE_ENV of [undefined, "production", "test"]) {
      expect(shouldRunDevTick({ NODE_ENV, DEV_TICK: "1" })).toBe(false);
    }
  });
});

describe("shouldKick", () => {
  test("production kicks, with or without DEV_TICK", () => {
    expect(shouldKick({ NODE_ENV: "production" })).toBe(true);
    expect(shouldKick({ NODE_ENV: "production", DEV_TICK: "0" })).toBe(true);
    expect(shouldKick({ NODE_ENV: "production", DEV_TICK: "1" })).toBe(true);
  });
  test("anywhere else it is a no-op unless DEV_TICK=1", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      expect(shouldKick({ NODE_ENV })).toBe(false);
      expect(shouldKick({ NODE_ENV, DEV_TICK: "" })).toBe(false);
      expect(shouldKick({ NODE_ENV, DEV_TICK: "true" })).toBe(false);
      expect(shouldKick({ NODE_ENV, DEV_TICK: "1" })).toBe(true);
    }
  });
});

describe("kickRunner", () => {
  test("schedules a tick in production and with the opt-in, and nowhere else", () => {
    const run = (env: { NODE_ENV?: string; DEV_TICK?: string }) => {
      const scheduled: unknown[] = [];
      kickRunner({ env, schedule: ((cb: unknown) => void scheduled.push(cb)) as never });
      return scheduled.length; // the callback is captured, never run: it would tick the real database
    };
    expect(run({ NODE_ENV: "production" })).toBe(1);
    expect(run({ NODE_ENV: "development", DEV_TICK: "1" })).toBe(1);
    expect(run({ NODE_ENV: "development" })).toBe(0);
    expect(run({ NODE_ENV: "test" })).toBe(0);
    expect(run({})).toBe(0);
  });
  test("outside a request scope (schedule throws) it stays silent", () => {
    expect(() => kickRunner({ env: { NODE_ENV: "production" }, schedule: (() => { throw new Error("outside a request scope"); }) as never })).not.toThrow();
  });
});

describe("instrumentation register()", () => {
  type G = { __reelcastDevTick?: unknown };
  const saved = { runtime: process.env.NEXT_RUNTIME, nodeEnv: process.env.NODE_ENV, devTick: process.env.DEV_TICK, setInterval: globalThis.setInterval, log: console.log };
  let intervals: { ms: number | undefined }[];
  let lines: string[];

  beforeEach(async () => {
    await import("./tick"); // load the heavy module before timers and console are stubbed
    intervals = [];
    lines = [];
    delete (globalThis as G).__reelcastDevTick;
    (process.env as Record<string, string | undefined>).NEXT_RUNTIME = "nodejs";
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    globalThis.setInterval = ((_fn: unknown, ms?: number) => (intervals.push({ ms }), {})) as never; // no real timer: nothing can tick
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  });
  afterEach(() => {
    globalThis.setInterval = saved.setInterval;
    console.log = saved.log;
    delete (globalThis as G).__reelcastDevTick;
    for (const [k, v] of [["NEXT_RUNTIME", saved.runtime], ["NODE_ENV", saved.nodeEnv], ["DEV_TICK", saved.devTick]] as const) {
      if (v === undefined) delete process.env[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  });

  test("without DEV_TICK=1 it starts no timer and prints exactly one line, once even if called again (HMR)", async () => {
    delete process.env.DEV_TICK;
    await register();
    await register();
    expect(intervals).toEqual([]);
    expect(lines.filter((l) => l.startsWith("[dev tick]"))).toEqual([DEV_TICK_OFF_MESSAGE]);
    expect(DEV_TICK_OFF_MESSAGE).toBe("[dev tick] off: the job runner is not running locally (DATABASE_URL may be the production database). Set DEV_TICK=1 in .env.local to run it.");
  });

  test("with DEV_TICK=1 it starts one 5 s timer (not stacked on a second call)", async () => {
    process.env.DEV_TICK = "1";
    await register();
    await register();
    expect(intervals).toEqual([{ ms: 5_000 }]);
    expect(lines.filter((l) => l.startsWith("[dev tick]"))).toEqual(["[dev tick] job runner started (every 5s)"]);
  });

  test("outside development (production build) it stays silent and starts nothing, even with DEV_TICK=1", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.DEV_TICK = "1";
    await register();
    expect(intervals).toEqual([]);
    expect(lines).toEqual([]);
  });
});
