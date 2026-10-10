import { describe, expect, test } from "bun:test";
import { sweeps } from "../handlers";

describe("system handlers are registered with the runner", () => {
  test("the retention sweep runs every 6 hours, once", () => {
    const named = sweeps.filter((s) => s.name === "maintenance.retention");
    expect(named).toHaveLength(1);
    expect(named[0].everyMs).toBe(6 * 60 * 60_000);
  });

  test("oauth.health keeps its interval", () => {
    expect(sweeps.find((s) => s.name === "oauth.health")?.everyMs).toBe(6 * 60 * 60_000);
  });
});
