/**
 * What the production tick request logs (scaling ladder M-2a). The runner is always a fake: a real tick would claim and
 * run real jobs against the shared database, so these tests never reach runTick and never touch the database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleTickRequest, logTickResult, type TickRunner } from "./cron";
import type { TickOptions, TickResult } from "./tick";

const SECRET = "test-cron-secret";
let previousSecret: string | undefined;
beforeAll(() => {
  previousSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
});

const logs: unknown[][] = [];
const errs: unknown[][] = [];
const spies: { mockRestore: () => void }[] = [];
beforeEach(() => {
  logs.length = 0;
  errs.length = 0;
  spies.push(spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a)));
  spies.push(spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a)));
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const idle = (over: Partial<TickResult> = {}): TickResult => ({ recovered: { jobs: 0, tasks: 0, failedJobs: 0 }, sweepsRun: [], jobsRun: 0, tasksRun: 0, errors: [], ...over });

const request = (headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }, query = "") => new Request(`http://localhost/api/cron/tick${query}`, { headers });

describe("logTickResult", () => {
  test("an idle tick logs nothing", () => {
    logTickResult(idle(), 12);
    expect(logs).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("one console.error line per error entry, each the JSON string of the entry", () => {
    const errors = ["job 1 (publish): quota exceeded", 'sweep digest: said "no"'];
    logTickResult(idle({ errors }), 5);
    expect(errs).toEqual([
      ["[tick] error", JSON.stringify(errors[0])],
      ["[tick] error", JSON.stringify(errors[1])],
    ]);
  });

  test("errors also produce the summary line, with the error count", () => {
    logTickResult(idle({ errors: ["a", "b"] }), 7);
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe("[tick]");
    expect(JSON.parse(logs[0][1] as string)).toEqual({ ms: 7, recovered: { jobs: 0, tasks: 0, failedJobs: 0 }, sweepsRun: [], jobsRun: 0, tasksRun: 0, errors: 2 });
  });

  const worked: [string, Partial<TickResult>][] = [
    ["jobs ran", { jobsRun: 2 }],
    ["tasks ran", { tasksRun: 1 }],
    ["a sweep ran", { sweepsRun: ["publish.scheduled"] }],
    ["jobs were recovered", { recovered: { jobs: 1, tasks: 0, failedJobs: 0 } }],
    ["tasks were recovered", { recovered: { jobs: 0, tasks: 1, failedJobs: 0 } }],
    ["a recovered job failed for good", { recovered: { jobs: 0, tasks: 0, failedJobs: 1 } }],
  ];
  for (const [what, over] of worked) {
    test(`one summary line when ${what}, and no error lines`, () => {
      logTickResult(idle(over), 33);
      expect(errs).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0][0]).toBe("[tick]");
      expect(JSON.parse(logs[0][1] as string)).toMatchObject({ ms: 33, errors: 0 });
    });
  }

  test("bound query values never reach the log: a failed-query entry is cut before its params line", () => {
    logTickResult(idle({ errors: ["job 9 (publish): Failed query: update \"x\" set \"y\" = $1\nparams: victim@example.test,tok_SECRET"] }), 1);
    expect(errs).toEqual([["[tick] error", JSON.stringify('job 9 (publish): Failed query: update "x" set "y" = $1')]]);
    expect(JSON.stringify([logs, errs])).not.toContain("victim@example.test");
  });

  test("an enormous error entry is capped so one failure cannot flood the log", () => {
    logTickResult(idle({ errors: ["x".repeat(50_000)] }), 1);
    expect(JSON.parse(errs[0][1] as string)).toHaveLength(1_000);
  });
});

describe("handleTickRequest", () => {
  test("rejects a missing or wrong secret without running a tick or logging", async () => {
    let calls = 0;
    const run: TickRunner = async () => (calls++, idle());
    expect((await handleTickRequest(request({}), run)).status).toBe(401);
    expect((await handleTickRequest(request({ authorization: "Bearer nope" }), run)).status).toBe(401);
    expect((await handleTickRequest(request({ "x-cron-secret": "nope" }), run)).status).toBe(401);
    expect(calls).toBe(0);
    expect(logs).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("accepts the secret as a Bearer token or an x-cron-secret header", async () => {
    const run: TickRunner = async () => idle();
    expect((await handleTickRequest(request({ authorization: `Bearer ${SECRET}` }), run)).status).toBe(200);
    expect((await handleTickRequest(request({ "x-cron-secret": SECRET }), run)).status).toBe(200);
  });

  test("logs every error of the run, then the summary, and still returns the whole result as JSON", async () => {
    const result = idle({ jobsRun: 3, errors: ["job 9 (generation): provider timeout"] });
    const res = await handleTickRequest(request(), async () => result);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ...result });
    expect(errs).toEqual([["[tick] error", JSON.stringify("job 9 (generation): provider timeout")]]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0][1] as string)).toMatchObject({ jobsRun: 3, errors: 1 });
    expect(typeof JSON.parse(logs[0][1] as string).ms).toBe("number");
  });

  test("an idle run logs nothing at all", async () => {
    await handleTickRequest(request(), async () => idle());
    expect(logs).toEqual([]);
    expect(errs).toEqual([]);
  });

  test("the cron route is the one caller that asks the tick to record its heartbeat", async () => {
    const seen: (string | null | undefined)[] = [];
    const run: TickRunner = async (o: TickOptions) => (seen.push(o.heartbeat), idle());
    await handleTickRequest(request(), run);
    expect(seen).toEqual(["tick.heartbeat"]);
  });

  test("passes the requested budget to the runner, clamped to 270s, defaulting to 240s", async () => {
    const budgets: (number | undefined)[] = [];
    const run: TickRunner = async (o: TickOptions) => (budgets.push(o.budgetMs), idle());
    for (const q of ["", "?budgetMs=25000", "?budgetMs=999999", "?budgetMs=abc", "?budgetMs=-5"]) await handleTickRequest(request(undefined, q), run);
    expect(budgets).toEqual([240_000, 25_000, 270_000, 240_000, 240_000]);
  });
});
