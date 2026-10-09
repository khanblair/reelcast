import { describe, expect, test } from "bun:test";
import { jobHandlers, sweeps, taskHandlers } from "../handlers";

describe("publishing handlers are registered with the runner", () => {
  test("the publish job and the auto-publish task have handlers", () => {
    expect(typeof jobHandlers.publish).toBe("function");
    expect(typeof taskHandlers["autoPublish.run"]).toBe("function");
  });

  test("sweeps run on the intervals the Convex crons used", () => {
    const by = Object.fromEntries(sweeps.map((s) => [s.name, s.everyMs]));
    expect(by["publish.dueSchedules"]).toBe(60_000); // "process scheduled publishes": every minute
    expect(by["oauth.health"]).toBe(6 * 60 * 60_000); // "check youtube oauth health": every 6 hours
    expect(by["publish.reconcile"]).toBe(5 * 60_000);
  });

  test("sweep names are unique (they are the claim key in job_schedules)", () => {
    const names = sweeps.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
