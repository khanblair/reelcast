/**
 * GET /api/health (scaling ladder M-4).
 *
 * The database is shared with the live tick, so nothing here touches the real `tick.heartbeat` row: each case plants
 * its own heartbeat row (a unique name, inside a transaction that is rolled back) and points the check at it with
 * `heartbeatName`. Inside one transaction `now()` is fixed, so a planted age comes back exactly and the 3-minute
 * boundary can be tested to the millisecond. The environment is always a synthetic object, never `process.env`.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import * as route from "@/app/api/health/route";
import { countQueries, inRolledBackTx } from "@/server/testing";
import { DB_TIMEOUT_MS, collectHealth, handleHealthRequest, httpStatusFor, statusFor, type HealthStatus } from "./health";
import type { Env } from "./env-check";
import { TICK_STALE_MS } from "./queue-health";

setDefaultTimeout(120_000);

const SECRET = `test-secret-${"x".repeat(40)}`;

function goodEnv(over: Env = {}): Env {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pw@db.invalid:6543/postgres",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.invalid",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CRON_SECRET: SECRET,
    NEXT_PUBLIC_APP_URL: "https://app.example.invalid",
    NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "cloud",
    CLOUDINARY_API_KEY: "ck",
    CLOUDINARY_API_SECRET: "cs",
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gs",
    GEMINI_API_KEY: "gem",
    NEXT_PUBLIC_POSTHOG_KEY: "ph",
    ...over,
  };
}

const anonymous = () => new Request("http://localhost/api/health");
const withSecret = (secret = SECRET) => new Request("http://localhost/api/health", { headers: { authorization: `Bearer ${secret}` } });

/** Plant a heartbeat of the given age under a unique name (null = no row at all). Returns the name. */
async function plantHeartbeat(tx: DbLike, ageMs: number | null): Promise<string> {
  const name = `test.heartbeat.${randomUUID()}`;
  if (ageMs !== null) await tx.execute(sql`insert into job_schedules (name, last_run_at) values (${name}, now() - ${ageMs} * interval '1 millisecond')`);
  return name;
}

/** A database whose every statement never answers. */
function hangingDb() {
  const calls = { execute: 0, select: 0 };
  const db = {
    execute: () => {
      calls.execute++;
      return new Promise(() => {});
    },
    select: () => {
      calls.select++;
      return new Promise(() => {});
    },
  } as unknown as DbLike;
  return { db, calls };
}

async function bodyOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("status mapping", () => {
  const FRESH = 0;
  const table: [string, { dbOk: boolean; tickAgeMs: number | null; envMissing: number }, HealthStatus, number][] = [
    ["everything fine", { dbOk: true, tickAgeMs: FRESH, envMissing: 0 }, "ok", 200],
    ["heartbeat exactly 3 minutes old is not stale yet", { dbOk: true, tickAgeMs: TICK_STALE_MS, envMissing: 0 }, "ok", 200],
    ["heartbeat 1 ms past 3 minutes is stale", { dbOk: true, tickAgeMs: TICK_STALE_MS + 1, envMissing: 0 }, "down", 503],
    ["no heartbeat row has ever been recorded", { dbOk: true, tickAgeMs: null, envMissing: 0 }, "degraded", 200],
    ["a required variable is missing", { dbOk: true, tickAgeMs: FRESH, envMissing: 1 }, "degraded", 200],
    ["missing variable and no heartbeat", { dbOk: true, tickAgeMs: null, envMissing: 2 }, "degraded", 200],
    ["stale heartbeat beats a missing variable", { dbOk: true, tickAgeMs: TICK_STALE_MS + 1, envMissing: 1 }, "down", 503],
    ["database down", { dbOk: false, tickAgeMs: null, envMissing: 0 }, "down", 503],
    ["database down beats everything", { dbOk: false, tickAgeMs: FRESH, envMissing: 3 }, "down", 503],
  ];
  for (const [label, facts, status, http] of table) {
    test(label, () => {
      expect(statusFor(facts)).toBe(status);
      expect(httpStatusFor(status)).toBe(http);
    });
  }

  test("the stale threshold is 3 minutes and the database gets 5 seconds", () => {
    expect(TICK_STALE_MS).toBe(180_000);
    expect(DB_TIMEOUT_MS).toBe(5_000);
  });
});

describe("a database that does not answer", () => {
  test("reports down within the timer (not the 120 s statement timeout), with 503 and no-store", async () => {
    const { db, calls } = hangingDb();
    const t0 = performance.now();
    const res = await handleHealthRequest(anonymous(), { db, env: goodEnv(), timeoutMs: 60 });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1_000);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toEqual({ status: "down" });
    expect(calls).toEqual({ execute: 1, select: 0 }); // only the ping was tried
  }, 5_000);

  test("the details say timeout, and skip the tick and the queue", async () => {
    const { db, calls } = hangingDb();
    const res = await handleHealthRequest(withSecret(), { db, env: goodEnv(), timeoutMs: 60 });
    expect(res.status).toBe(503);
    const body = await bodyOf(res);
    expect(body).toMatchObject({ status: "down", db: { ok: false, ms: null, error: "timeout" }, tick: null, queue: null });
    expect(calls).toEqual({ execute: 1, select: 0 });
  }, 5_000);

  describe("the one timer covers every statement, not just the ping", () => {
    /** Awaiting it never settles; any method call on it returns itself (a drizzle select chain that hangs). */
    const hangs: unknown = new Proxy({}, { get: (_t, prop) => (prop === "then" ? () => {} : () => hangs) });
    /** The same chain, but it resolves to `rows`. */
    const answers = (rows: unknown[]): unknown => new Proxy({}, { get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve(rows) : () => answers(rows)) });

    test("the heartbeat read hangs after a good ping", async () => {
      const db = { execute: async () => [{ "?column?": 1 }], select: () => hangs } as unknown as DbLike;
      const t0 = performance.now();
      const res = await handleHealthRequest(withSecret(), { db, env: goodEnv(), timeoutMs: 60 });
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(res.status).toBe(503);
      expect(await bodyOf(res)).toMatchObject({ status: "down", db: { ok: false, error: "timeout" }, tick: null, queue: null });
    }, 5_000);

    test("the queue-depth statement hangs after a good ping and heartbeat", async () => {
      let executes = 0;
      const db = {
        execute: () => (++executes === 1 ? Promise.resolve([{ "?column?": 1 }]) : new Promise(() => {})),
        select: () => answers([]),
      } as unknown as DbLike;
      const t0 = performance.now();
      const res = await handleHealthRequest(withSecret(), { db, env: goodEnv(), timeoutMs: 60 });
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(res.status).toBe(503);
      expect(await bodyOf(res)).toMatchObject({ status: "down", db: { ok: false, error: "timeout" }, queue: null });
      expect(executes).toBe(2);
    }, 5_000);
  });

  test("a failing database is down too, and its message (pooler host, user) is never returned", async () => {
    const db = { execute: async () => { throw new Error("connect ECONNREFUSED LEAKSENTINEL-pooler.supabase.com:6543 user=LEAKSENTINEL"); } } as unknown as DbLike;
    const res = await handleHealthRequest(withSecret(), { db, env: goodEnv(), timeoutMs: 1_000 });
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('"error":"error"');
    expect(text).not.toContain("LEAKSENTINEL");
  });

  test("a database object that throws on first use (DATABASE_URL unset) is down, not a crash", async () => {
    const db = new Proxy({}, { get() { throw new Error("DATABASE_URL is not set"); } }) as unknown as DbLike;
    const res = await handleHealthRequest(anonymous(), { db, env: goodEnv(), timeoutMs: 1_000 });
    expect(res.status).toBe(503);
    expect(await bodyOf(res)).toEqual({ status: "down" });
  });

  test("a statement that fails after the timer has fired does not become an unhandled rejection", async () => {
    const events: unknown[] = [];
    const listener = (e: unknown) => void events.push(e);
    process.on("unhandledRejection", listener);
    try {
      const db = { execute: () => new Promise((_, reject) => setTimeout(() => reject(new Error("late failure")), 120)) } as unknown as DbLike;
      const report = await collectHealth({ db, env: goodEnv(), timeoutMs: 20, heartbeatName: "x", withQueue: true });
      expect(report.status).toBe("down");
      await new Promise((r) => setTimeout(r, 300));
      expect(events).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("against the database", () => {
  test("ok / stale / missing heartbeat and missing variables map to the right status and HTTP code", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const fresh = await plantHeartbeat(tx, 0);
      const edge = await plantHeartbeat(tx, TICK_STALE_MS);
      const stale = await plantHeartbeat(tx, TICK_STALE_MS + 1);
      const never = await plantHeartbeat(tx, null);
      const run = async (heartbeatName: string, env: Env) => {
        const res = await handleHealthRequest(anonymous(), { db: tx, env, heartbeatName });
        return [(await bodyOf(res)).status, res.status] as const;
      };
      const noCloudinary = goodEnv({ CLOUDINARY_API_KEY: undefined });
      expect(await run(fresh, goodEnv())).toEqual(["ok", 200]);
      expect(await run(edge, goodEnv())).toEqual(["ok", 200]);
      expect(await run(stale, goodEnv())).toEqual(["down", 503]);
      expect(await run(never, goodEnv())).toEqual(["degraded", 200]);
      expect(await run(fresh, noCloudinary)).toEqual(["degraded", 200]);
      expect(await run(stale, noCloudinary)).toEqual(["down", 503]);
      expect(await run(never, noCloudinary)).toEqual(["degraded", 200]);
    });
  });

  test("without the secret the body is exactly {status}; a wrong or empty secret gets the same", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const heartbeatName = await plantHeartbeat(tx, 0);
      const deps = { db: tx, env: goodEnv(), heartbeatName };
      for (const req of [
        anonymous(),
        withSecret("wrong-secret"),
        withSecret(""),
        withSecret(SECRET + "x"),
        withSecret(SECRET.slice(0, -1)),
        new Request("http://localhost/api/health", { headers: { "x-cron-secret": "nope" } }),
      ]) {
        const res = await handleHealthRequest(req, deps);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await bodyOf(res)).toEqual({ status: "ok" });
      }
    });
  });

  test("a deployment with no CRON_SECRET never returns details, even to an empty bearer token", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const heartbeatName = await plantHeartbeat(tx, 0);
      for (const secret of [undefined, ""]) {
        const env = goodEnv({ CRON_SECRET: secret });
        for (const req of [withSecret(""), withSecret("undefined"), anonymous()]) {
          expect(Object.keys(await bodyOf(await handleHealthRequest(req, { db: tx, env, heartbeatName })))).toEqual(["status"]);
        }
      }
    });
  });

  test("with the secret (Bearer or x-cron-secret) the details are added", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const heartbeatName = await plantHeartbeat(tx, 42_000);
      const env = goodEnv({ GEMINI_API_KEY: undefined, CLOUDINARY_API_KEY: undefined });
      for (const req of [withSecret(), new Request("http://localhost/api/health", { headers: { "x-cron-secret": SECRET } })]) {
        const res = await handleHealthRequest(req, { db: tx, env, heartbeatName });
        expect(res.status).toBe(200);
        const body = (await bodyOf(res)) as {
          status: string;
          db: { ok: boolean; ms: number };
          tick: { lastRunAt: string; ageMs: number; stale: boolean };
          queue: { jobs: Record<string, unknown>; tasks: Record<string, unknown>; oldestPendingAgeMs: number | null };
          env: { missing: string[]; warnings: string[] };
        };
        expect(Object.keys(body).sort()).toEqual(["db", "env", "queue", "status", "tick"]);
        expect(body.status).toBe("degraded"); // CLOUDINARY_API_KEY is missing
        expect(body.db.ok).toBe(true);
        expect(typeof body.db.ms).toBe("number");
        expect(body.tick.ageMs).toBe(42_000);
        expect(body.tick.stale).toBe(false);
        expect(Number.isNaN(Date.parse(body.tick.lastRunAt))).toBe(false);
        expect(Object.keys(body.queue.jobs).sort()).toEqual(["failedLast24h", "oldestPendingAgeMs", "pending", "processing", "scheduled"]);
        expect(Object.keys(body.queue.tasks).sort()).toEqual(["failedLast24h", "oldestPendingAgeMs", "pending", "processing", "scheduled"]);
        expect(body.env.missing).toEqual(["CLOUDINARY_API_KEY"]);
        expect(body.env.warnings.some((w) => w.startsWith("GEMINI_API_KEY "))).toBe(true);
      }
    });
  });

  test("details show a stale tick as stale, and a missing heartbeat as no lastRunAt", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const stale = await plantHeartbeat(tx, TICK_STALE_MS + 1);
      const never = await plantHeartbeat(tx, null);
      const a = (await bodyOf(await handleHealthRequest(withSecret(), { db: tx, env: goodEnv(), heartbeatName: stale }))) as { status: string; tick: Record<string, unknown> };
      expect(a.status).toBe("down");
      expect(a.tick).toMatchObject({ ageMs: TICK_STALE_MS + 1, stale: true });
      const b = (await bodyOf(await handleHealthRequest(withSecret(), { db: tx, env: goodEnv(), heartbeatName: never }))) as { status: string; tick: Record<string, unknown> };
      expect(b.status).toBe("degraded");
      expect(b.tick).toEqual({ lastRunAt: null, ageMs: null, stale: false });
    });
  });

  test("no environment value appears in any response, with or without the secret, healthy or not", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const heartbeatName = await plantHeartbeat(tx, 0);
      const leaky: Env = {};
      for (const name of Object.keys(goodEnv())) leaky[name] = `LEAKSENTINEL_${name}_value`;
      leaky.NODE_ENV = "production";
      leaky.CRON_SECRET = `LEAKSENTINEL_CRON_SECRET_${"y".repeat(40)}`; // long enough to be valid; also the bearer token
      for (const env of [leaky, { ...leaky, CLOUDINARY_API_SECRET: undefined }]) {
        for (const req of [anonymous(), withSecret(env.CRON_SECRET)]) {
          const res = await handleHealthRequest(req, { db: tx, env, heartbeatName });
          const text = await res.text();
          expect(text).not.toContain("LEAKSENTINEL");
          expect(JSON.parse(text).status).toBeDefined();
        }
      }
      // ...and the names are what is reported, not the values
      const detailed = (await bodyOf(await handleHealthRequest(withSecret(leaky.CRON_SECRET), { db: tx, env: leaky, heartbeatName }))) as { env: { missing: string[] } };
      expect(detailed.env.missing).toEqual(["APP_ENCRYPTION_KEY", "NEXT_PUBLIC_APP_URL"]); // the sentinel is not a 32-byte key / an https URL
    });
  });

  test("statements: 2 without the secret (ping, heartbeat), 3 with it (plus the queue depth), never more", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const heartbeatName = await plantHeartbeat(tx, 0);
      const deps = { db: tx, env: goodEnv(), heartbeatName };
      const anon = await countQueries(() => handleHealthRequest(anonymous(), deps));
      expect(anon.queries).toBe(2);
      expect(anon.statements[0].toLowerCase()).toContain("select 1");
      expect(anon.statements.join("\n").toLowerCase()).not.toMatch(/count\(|from "?(jobs|tasks)"?/); // no aggregate for an anonymous caller
      const authed = await countQueries(() => handleHealthRequest(withSecret(), deps));
      expect(authed.queries).toBe(3);
    });
  });
});

describe("the route", () => {
  test("is dynamic, has a small maxDuration above the database timer, and exports GET", () => {
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.maxDuration).toBeGreaterThan(DB_TIMEOUT_MS / 1000);
    expect(route.maxDuration).toBeLessThanOrEqual(30);
    expect(typeof route.GET).toBe("function");
  });

  test("GET with the real defaults needs no session, answers with a status and nothing else, and costs 2 statements", async () => {
    const { result: res, queries } = await countQueries(() => route.GET(anonymous()));
    const body = await bodyOf(res);
    expect(Object.keys(body)).toEqual(["status"]); // whatever the live state is: no details without the secret
    expect(["ok", "degraded", "down"]).toContain(body.status as string);
    expect(res.status).toBe(body.status === "down" ? 503 : 200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(queries).toBeLessThanOrEqual(2);
  });
});
