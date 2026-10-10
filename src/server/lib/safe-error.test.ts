import { inspect } from "node:util";
import { describe, expect, test } from "bun:test";
import { safeErrorMessage, stripQueryParams, unhandledErrorDetail } from "./safe-error";

const EMAIL = "victim@example.test";

/** What a failed insert looks like after drizzle-orm and postgres.js are done with it. */
function drizzleFailure() {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
    name: "PostgresError",
    code: "23505",
    detail: `Key (email)=(${EMAIL}) already exists.`,
    severity: "ERROR",
  });
  const err = new Error(`Failed query: insert into "users" ("email") values ($1)\nparams: ${EMAIL}`, { cause: pg }) as Error & { query: string; params: string[] };
  err.query = 'insert into "users" ("email") values ($1)';
  err.params = [EMAIL];
  return err;
}

describe("stripQueryParams", () => {
  test("cuts a Drizzle failed-query message at its params line, keeping the SQL with its placeholders", () => {
    expect(stripQueryParams(`Failed query: select 1 where a = $1\nparams: ${EMAIL}`)).toBe("Failed query: select 1 where a = $1");
    expect(stripQueryParams(`job 9 (publish): Failed query: update x set y = $1\nparams: ${EMAIL},tok_SECRET`)).toBe("job 9 (publish): Failed query: update x set y = $1");
  });
  test("a bound value that contains the marker cannot smuggle itself through", () => {
    expect(stripQueryParams(`Failed query: q $1\nparams: a\nparams: ${EMAIL}`)).toBe("Failed query: q $1");
  });
  test("other text, including the word params, is untouched", () => {
    expect(stripQueryParams("sweep digest: quota exceeded")).toBe("sweep digest: quota exceeded");
    expect(stripQueryParams("bad\nparams: not a database error")).toBe("bad\nparams: not a database error");
    expect(stripQueryParams("Failed query: select 1")).toBe("Failed query: select 1");
  });
});

describe("safeErrorMessage", () => {
  test("a failed query is described by the database's own message, one line, capped", () => {
    expect(safeErrorMessage(drizzleFailure())).toBe('duplicate key value violates unique constraint "users_email_key"');
    expect(safeErrorMessage(new Error(`Failed query: x\nparams: ${EMAIL}`))).toBe("Failed query");
    expect(safeErrorMessage(new Error(`first\nsecond ${EMAIL}`))).toBe("first");
    expect(safeErrorMessage(new Error("x".repeat(1_000))).length).toBe(300);
    expect(safeErrorMessage("a string")).toBe("Non-error value thrown");
  });
});

describe("unhandledErrorDetail", () => {
  test("keeps name, code, safe message and stack frames; nothing of the bound values or the server's detail", () => {
    const detail = unhandledErrorDetail(drizzleFailure());
    expect(typeof detail).toBe("string");
    expect(detail.split("\n")[0]).toBe('Error [23505]: duplicate key value violates unique constraint "users_email_key"');
    expect(detail).toMatch(/\n\s+at /); // frames are still there
    expect(detail).not.toContain(EMAIL);
    expect(detail).not.toContain("params");
    expect(detail).not.toContain("Key (email)");
  });

  test("the raw error object WOULD leak when printed: that is why the string is logged instead", () => {
    const raw = inspect(drizzleFailure(), { depth: 5 });
    expect(raw).toContain(EMAIL); // message, stack, own `params` and the cause's `detail`
  });

  test("a plain error and a thrown string are handled", () => {
    expect(unhandledErrorDetail(new Error("boom")).split("\n")[0]).toBe("Error: boom");
    expect(unhandledErrorDetail("oops")).toBe("string: Non-error value thrown");
  });
});
