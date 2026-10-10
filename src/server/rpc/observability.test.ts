/**
 * The per-call log line, the auth-lookup warning and the error-reporter hook (scaling ladder M-1).
 *
 * The line is captured from the console, so the test sees exactly what the platform log would. Handlers come from small
 * fake registries; database-backed cases run in rolled-back transactions. Only requests that the route refuses BEFORE
 * dispatch are sent through the real route handler here, so no request ever reaches a session or the database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { POST } from "@/app/api/rpc/route";
import { setErrorReporter, type ErrorReport } from "@/server/lib/error-reporter";
import { callRpc, countQueries, inRolledBackTx } from "@/server/testing";
import { mutation, query, type UserRow } from "./define";
import { classifyError, dispatch, toErrorBody } from "./dispatch";
import { RpcError, badRequest, conflict, forbidden, notFound, planLimit } from "./errors";
import { setRpcLogging } from "./log";

setDefaultTimeout(120_000);

const EMAIL = "victim@example.test";
const TOKEN = "tok_SECRET_123";

const api = {
  ok: query({ handler: async () => ({ hello: "world" }) }),
  mine: query({ handler: async (ctx) => ({ id: ctx.userId }) }),
  admin: mutation({ auth: "admin", handler: async () => "ok" }),
  open: query({ auth: "public", handler: async (ctx) => ({ who: ctx.userId }) }),
  withArgs: mutation({ input: z.object({ email: z.string(), token: z.string() }), handler: async () => "done" }),
  strict: mutation({ input: z.object({ n: z.number().int().min(1) }), handler: async (_c, a) => a.n }),
  notFound: query({ handler: async () => { throw notFound("no such thing"); } }),
  forbidden: query({ handler: async () => { throw forbidden("not yours"); } }),
  badRequest: query({ handler: async () => { throw badRequest("nope"); } }),
  rate: mutation({ handler: async () => { throw new RpcError("RATE_LIMITED", "slow down"); } }),
  plan: mutation({ handler: async () => { throw planLimit("videos"); } }),
  conflict: mutation({ handler: async () => { throw conflict("already there"); } }),
  zod: query({ handler: async () => z.string().parse(5) }),
  boom: query({ handler: async () => { throw new Error(`db exploded for ${EMAIL} with ${TOKEN}`); } }),
  boomWithArgs: mutation({
    input: z.object({ email: z.string(), token: z.string() }),
    handler: async () => { throw new Error(`db exploded for ${EMAIL} with ${TOKEN}`); },
  }),
  internal: query({ handler: async () => { throw new RpcError("INTERNAL", "explicit internal"); } }),
  twoSelects: query({
    handler: async (ctx) => {
      await ctx.db.execute(sql`select 1`);
      await ctx.db.execute(sql`select 2`);
      return "x";
    },
  }),
  nested: { deep: { fn: query({ handler: async () => "deep" }) } },
};

type Line = { evt: string; path: string; ok: boolean; code: string | null; ms: number; stmts: number; uid: string | null };
type Level = "log" | "warn" | "error";

const out: Record<Level, string[]> = { log: [], warn: [], error: [] };
/** Everything written to the console, in order, with its level. */
let seq: { level: Level; raw: string }[] = [];
const spies: { mockRestore: () => void }[] = [];
let wasLogging = false;

beforeAll(() => void (wasLogging = setRpcLogging(true)));
afterAll(() => void setRpcLogging(wasLogging));
beforeEach(() => {
  seq = [];
  for (const level of ["log", "warn", "error"] as const) {
    out[level] = [];
    spies.push(
      spyOn(console, level).mockImplementation((...args: unknown[]) => {
        const raw = args.map(String).join(" ");
        out[level].push(raw);
        seq.push({ level, raw });
      }),
    );
  }
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  setErrorReporter(null);
});

/** Every captured line that is a JSON object with the given evt, with the level it was written at. */
const evtLines = (evt: string) =>
  seq.filter((l) => l.raw.startsWith(`{"evt":"${evt}"`)).map(({ level, raw }) => ({ level, raw, json: JSON.parse(raw) as Record<string, unknown> }));
const rpcLines = () => evtLines("rpc") as { level: Level; raw: string; json: Line }[];
const everything = () => [...out.log, ...out.warn, ...out.error].join("\n");

const fakeUser = (over: Record<string, unknown> = {}) => ({ id: "11111111-1111-4111-8111-111111111111", email: EMAIL, name: "Vic Tim", isAdmin: false, ...over }) as unknown as UserRow;

describe("the rpc line: shape and level", () => {
  test("success: exactly one console.log line with the seven fixed fields", async () => {
    const user = fakeUser();
    await callRpc("ok", {}, { user }, api);
    const lines = rpcLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("log");
    expect(Object.keys(lines[0].json)).toEqual(["evt", "path", "ok", "code", "ms", "stmts", "uid"]);
    expect(lines[0].json).toMatchObject({ evt: "rpc", path: "ok", ok: true, code: null, stmts: 0, uid: "11111111-1111-4111-8111-111111111111" });
    expect(Number.isInteger(lines[0].json.ms)).toBe(true);
    expect(lines[0].json.ms).toBeGreaterThanOrEqual(0);
    expect(out.warn).toEqual([]);
    expect(out.error).toEqual([]);
  });

  test("a signed-out public call logs uid null; nested paths log their full path", async () => {
    await callRpc("open", {}, { user: null }, api);
    await callRpc("nested.deep.fn", {}, { user: fakeUser() }, api);
    expect(rpcLines().map((l) => [l.json.path, l.json.uid === null])).toEqual([["open", true], ["nested.deep.fn", false]]);
  });

  const clientErrors: [string, string, string, Record<string, unknown>?][] = [
    // [description, path, expected code, args]
    ["unknown path", "nope.nada", "NOT_FOUND"],
    ["handler NOT_FOUND", "notFound", "NOT_FOUND"],
    ["handler FORBIDDEN", "forbidden", "FORBIDDEN"],
    ["handler BAD_REQUEST", "badRequest", "BAD_REQUEST"],
    ["input validation", "strict", "BAD_REQUEST", { n: 0 }],
    ["handler-thrown ZodError", "zod", "BAD_REQUEST"],
    ["RATE_LIMITED", "rate", "RATE_LIMITED"],
    ["PLAN_LIMIT_EXCEEDED", "plan", "PLAN_LIMIT_EXCEEDED"],
    ["CONFLICT", "conflict", "CONFLICT"],
  ];
  for (const [what, path, code, args] of clientErrors) {
    test(`client error (${what}) is one console.warn line with code ${code}`, async () => {
      await expect(callRpc(path, args ?? {}, { user: fakeUser() }, api)).rejects.toBeDefined();
      const lines = rpcLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe("warn");
      expect(lines[0].json).toMatchObject({ evt: "rpc", ok: false, code });
      expect(out.log).toEqual([]);
      expect(out.error).toEqual([]);
    });
  }

  test("UNAUTHENTICATED and FORBIDDEN are warnings; FORBIDDEN knows the user, UNAUTHENTICATED does not", async () => {
    await expect(callRpc("mine", {}, { user: null }, api)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(callRpc("admin", {}, { user: fakeUser({ isAdmin: false }) }, api)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const lines = rpcLines();
    expect(lines.map((l) => [l.level, l.json.code, l.json.uid])).toEqual([
      ["warn", "UNAUTHENTICATED", null],
      ["warn", "FORBIDDEN", "11111111-1111-4111-8111-111111111111"],
    ]);
  });

  test("unexpected errors and RpcError INTERNAL are console.error lines with code INTERNAL", async () => {
    await expect(callRpc("boom", {}, { user: fakeUser() }, api)).rejects.toThrow("db exploded");
    await expect(callRpc("internal", {}, { user: fakeUser() }, api)).rejects.toMatchObject({ code: "INTERNAL" });
    const lines = rpcLines();
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.level).toBe("error");
      expect(l.json).toMatchObject({ evt: "rpc", ok: false, code: "INTERNAL" });
    }
    expect(out.log).toEqual([]);
    expect(out.warn).toEqual([]);
  });

  test("the code in the line is the code on the wire", async () => {
    const thrown: unknown[] = [notFound("x"), badRequest("x"), new RpcError("RATE_LIMITED"), conflict("x"), new RpcError("INTERNAL"), (() => { try { z.string().parse(1); } catch (e) { return e; } })(), new Error("x"), "a string"];
    for (const err of thrown) {
      const { code, status } = classifyError(err);
      const body = toErrorBody(err);
      expect(body.body.error.code).toBe(code);
      expect(body.status).toBe(status);
    }
    expect(classifyError(new Error("x")).code).toBe("INTERNAL");
    expect(classifyError("a string").code).toBe("INTERNAL");
  });

  test("logging switched off: no output at all", async () => {
    setRpcLogging(false);
    try {
      await callRpc("ok", {}, { user: fakeUser() }, api);
      await expect(callRpc("boom", {}, { user: fakeUser() }, api)).rejects.toBeDefined();
    } finally {
      setRpcLogging(true);
    }
    expect(everything()).toBe("");
  });
});

describe("the rpc line: no personal data", () => {
  test("arguments, the user's email and the error message / stack never reach the line", async () => {
    const user = fakeUser();
    await callRpc("withArgs", { email: EMAIL, token: TOKEN }, { user }, api);
    await expect(callRpc("boomWithArgs", { email: EMAIL, token: TOKEN }, { user }, api)).rejects.toThrow("db exploded");
    await expect(callRpc("notFound", {}, { user }, api)).rejects.toBeDefined();
    await expect(callRpc("strict", { n: EMAIL, token: TOKEN }, { user }, api)).rejects.toMatchObject({ code: "BAD_REQUEST" }); // fails validation before auth: uid null
    const text = everything();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("example.test");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("Vic Tim");
    expect(text).not.toContain("db exploded");
    expect(text).not.toContain("no such thing");
    expect(text).not.toMatch(/\bat .*\.ts:\d+/); // no stack frames
    for (const l of rpcLines()) expect(Object.keys(l.json)).toEqual(["evt", "path", "ok", "code", "ms", "stmts", "uid"]);
    expect(rpcLines().map((l) => [l.json.path, l.json.code, l.json.uid])).toEqual([
      ["withArgs", null, user.id],
      ["boomWithArgs", "INTERNAL", user.id],
      ["notFound", "NOT_FOUND", user.id],
      ["strict", "BAD_REQUEST", null],
    ]);
  });

  test("a client-supplied path is length-capped and cannot break the line", async () => {
    const hostile = `x\n{"evt":"rpc","forged":true}${"a".repeat(500)}`;
    await expect(callRpc(hostile, {}, { user: fakeUser() }, api)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(out.warn).toHaveLength(1); // newline is escaped by JSON: still ONE line
    expect(out.warn[0]).not.toContain("\n");
    const json = JSON.parse(out.warn[0]) as Line;
    expect(json.path.length).toBe(120);
    expect(JSON.stringify(json)).not.toContain('"forged"');
  });
});

describe("the rpc line: statement count", () => {
  test("with no outer counter (production) stmts is the statements the call ran", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await callRpc("twoSelects", {}, { user, tx }, api);
      await callRpc("ok", {}, { user, tx }, api);
    });
    expect(rpcLines().map((l) => l.json.stmts)).toEqual([2, 0]);
  });

  test("an active countQueries() is reused, not shadowed: the test still counts, and each line counts only its own call", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const counted = await countQueries(async () => {
        await callRpc("twoSelects", {}, { user, tx }, api);
        await callRpc("twoSelects", {}, { user, tx }, api);
        return "done";
      });
      expect(counted.queries).toBe(4); // would be 0 if dispatch opened its own store
      expect(counted.statements.map((s) => s.trim())).toEqual(["select 1", "select 2", "select 1", "select 2"]); // SQL text kept for the outer test
      expect(rpcLines().map((l) => l.json.stmts)).toEqual([2, 2]); // delta, not cumulative (2, 4)
    });
  });

  test("a failing call still reports the statements it ran", async () => {
    const failing = {
      oops: mutation({
        handler: async (ctx) => {
          await ctx.db.execute(sql`select 1`);
          throw new Error("late failure");
        },
      }),
    };
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("oops", {}, { user, tx }, failing)).rejects.toThrow("late failure");
    });
    expect(rpcLines()[0].json).toMatchObject({ ok: false, code: "INTERNAL", stmts: 1 });
  });
});

describe("error reporter hook", () => {
  const reports: ErrorReport[] = [];
  beforeEach(() => {
    reports.length = 0;
    setErrorReporter((r) => void reports.push(r));
  });

  test("is called only for INTERNAL / unexpected errors, with {path, code, message, uid}", async () => {
    const user = fakeUser();
    await callRpc("ok", {}, { user }, api);
    for (const path of ["notFound", "forbidden", "badRequest", "rate", "plan", "conflict", "zod", "nope.nada"]) await expect(callRpc(path, {}, { user }, api)).rejects.toBeDefined();
    await expect(callRpc("mine", {}, { user: null }, api)).rejects.toBeDefined();
    expect(reports).toEqual([]);

    await expect(callRpc("boom", {}, { user }, api)).rejects.toBeDefined();
    await expect(callRpc("internal", {}, { user }, api)).rejects.toBeDefined();
    expect(reports).toHaveLength(2);
    expect(Object.keys(reports[0])).toEqual(["path", "code", "message", "uid"]);
    expect(reports[0]).toEqual({ path: "boom", code: "INTERNAL", message: `db exploded for ${EMAIL} with ${TOKEN}`, uid: user.id });
    expect(reports[1]).toEqual({ path: "internal", code: "INTERNAL", message: "explicit internal", uid: user.id });
  });

  test("a Drizzle 'Failed query' error is reported by its database message, never with the bound parameters", async () => {
    const failing = {
      insert: mutation({
        handler: async () => {
          throw new Error(`Failed query: insert into users (email) values ($1)\nparams: ${EMAIL}`, { cause: new Error('duplicate key value violates unique constraint "users_email_key"') });
        },
      }),
    };
    await expect(callRpc("insert", {}, { user: fakeUser() }, failing)).rejects.toBeDefined();
    expect(reports).toHaveLength(1);
    expect(reports[0].message).toBe('duplicate key value violates unique constraint "users_email_key"');
    expect(JSON.stringify(reports)).not.toContain(EMAIL);
  });

  test("a reporter that throws or rejects never changes the outcome", async () => {
    const user = fakeUser();
    setErrorReporter(() => { throw new Error("reporter down"); });
    await expect(callRpc("boom", {}, { user }, api)).rejects.toThrow("db exploded");
    setErrorReporter(async () => { throw new Error("reporter rejected"); });
    await expect(callRpc("boom", {}, { user }, api)).rejects.toThrow("db exploded");
    await Promise.resolve(); // let the swallowed rejection settle: it must not surface as unhandled
    expect(rpcLines().filter((l) => l.json.code === "INTERNAL")).toHaveLength(2); // the line is still written
  });

  test("the default reporter does nothing, and setErrorReporter(null) restores it", async () => {
    setErrorReporter(null);
    await expect(callRpc("boom", {}, { user: fakeUser() }, api)).rejects.toThrow("db exploded");
    expect(reports).toEqual([]);
    const previous = setErrorReporter((r) => void reports.push(r));
    expect(typeof previous).toBe("function");
  });
});

describe("rpc_auth_error: the swallowed getSessionUser() failure", () => {
  const req = new Request("http://localhost/api/rpc", { method: "POST" });

  test("a failed session lookup on a public function keeps the call anonymous and warns once, without the error message", async () => {
    // No override: dispatch calls the real getSessionUser(), which throws here (no request scope for cookies()).
    const result = await dispatch({ registry: api, path: "open", args: {}, req });
    expect(result).toEqual({}); // unchanged behaviour: served as signed-out ({ who: null } with nulls dropped on the wire)

    const auth = evtLines("rpc_auth_error");
    expect(auth).toHaveLength(1);
    expect(auth[0].level).toBe("warn");
    expect(Object.keys(auth[0].json)).toEqual(["evt", "path", "error", "code"]);
    expect(auth[0].json).toMatchObject({ evt: "rpc_auth_error", path: "open" });
    expect(typeof auth[0].json.error).toBe("string");
    expect(JSON.stringify(auth[0].json)).not.toMatch(/\bat .*\.ts:\d+/);

    const calls = rpcLines();
    expect(calls).toHaveLength(1); // the auth warning is in addition to, not instead of, the call line
    expect(calls[0]).toMatchObject({ level: "log" });
    expect(calls[0].json).toMatchObject({ ok: true, uid: null });
  });

  test("a signed-in or injected user never triggers it", async () => {
    await callRpc("open", {}, { user: null }, api);
    await callRpc("open", {}, { user: fakeUser() }, api);
    expect(evtLines("rpc_auth_error")).toEqual([]);
  });
});

describe("requests refused before dispatch still get their one line", () => {
  const call = (init: { headers?: Record<string, string>; body?: string }) =>
    POST(new Request("http://localhost/api/rpc", { method: "POST", headers: { "content-type": "application/json", ...init.headers }, body: init.body ?? "{}" }));

  const cases: [string, Parameters<typeof call>[0], number, string][] = [
    ["cross-site", { headers: { "sec-fetch-site": "cross-site" } }, 403, "FORBIDDEN"],
    ["not JSON", { headers: { "content-type": "text/plain" } }, 400, "BAD_REQUEST"],
    ["invalid JSON", { body: "{nope" }, 400, "BAD_REQUEST"],
    ["JSON null", { body: "null" }, 400, "BAD_REQUEST"],
    ["missing path", { body: JSON.stringify({ args: { email: EMAIL } }) }, 400, "BAD_REQUEST"],
  ];
  for (const [what, init, status, code] of cases) {
    test(`${what}: ${status} ${code}, one warn line, no arguments`, async () => {
      const res = await call(init);
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
      const lines = rpcLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe("warn");
      expect(lines[0].json).toMatchObject({ evt: "rpc", path: "(none)", ok: false, code, stmts: 0, uid: null });
      expect(everything()).not.toContain(EMAIL);
    });
  }
});
