import { describe, expect, test } from "bun:test";
import { jobTypeLabel } from "./status";

describe("jobTypeLabel", () => {
  test("capitalises a job type", () => {
    expect(jobTypeLabel("publish")).toBe("Publish");
    expect(jobTypeLabel("generation")).toBe("Generation");
  });

  test("a missing type reads Unknown instead of throwing (it crashed the admin overview table)", () => {
    expect(jobTypeLabel(undefined)).toBe("Unknown");
    expect(jobTypeLabel(null)).toBe("Unknown");
    expect(jobTypeLabel("")).toBe("Unknown");
  });
});
