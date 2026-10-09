import { describe, expect, test } from "bun:test";
import { computeNextAutoPublishAt, nextSlotMs } from "./schedule";

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

describe("computeNextAutoPublishAt: interval mode", () => {
  test("adds the interval to `from`", () => {
    const from = at("2026-03-01T10:00:00Z");
    expect(computeNextAutoPublishAt({ autoPublishIntervalMs: 2 * HOUR }, from)).toEqual(at("2026-03-01T12:00:00Z"));
  });
  test("defaults to 6 hours; non-positive intervals fall back to the default", () => {
    const from = at("2026-03-01T10:00:00Z");
    expect(computeNextAutoPublishAt({}, from)).toEqual(at("2026-03-01T16:00:00Z"));
    expect(computeNextAutoPublishAt({ autoPublishIntervalMs: 0 }, from)).toEqual(at("2026-03-01T16:00:00Z"));
    expect(computeNextAutoPublishAt({ autoPublishIntervalMs: null, autoPublishTimeSlots: [] }, from)).toEqual(at("2026-03-01T16:00:00Z"));
  });
});

describe("computeNextAutoPublishAt: time-slot mode", () => {
  const eat = { autoPublishTimeSlots: [18, 9], autoPublishTimezoneOffset: 3 }; // unsorted on purpose

  test("picks the next slot later today in the user's timezone", () => {
    // 05:30Z = 08:30 EAT -> 09:00 EAT = 06:00Z
    expect(computeNextAutoPublishAt(eat, at("2026-01-10T05:30:00Z"))).toEqual(at("2026-01-10T06:00:00Z"));
    // 06:00:30Z = 09:00:30 EAT -> 18:00 EAT = 15:00Z
    expect(computeNextAutoPublishAt(eat, at("2026-01-10T06:00:30Z"))).toEqual(at("2026-01-10T15:00:00Z"));
  });

  test("rolls to the first slot of the next local day after the last slot", () => {
    // 16:00Z = 19:00 EAT -> tomorrow 09:00 EAT = 06:00Z
    expect(computeNextAutoPublishAt(eat, at("2026-01-10T16:00:00Z"))).toEqual(at("2026-01-11T06:00:00Z"));
  });

  test("a slot less than 60s away is skipped", () => {
    // 08:59:30 EAT: 09:00 is 30s away -> 18:00 EAT
    expect(computeNextAutoPublishAt(eat, at("2026-01-10T05:59:30Z"))).toEqual(at("2026-01-10T15:00:00Z"));
    // exactly 60s away is allowed
    expect(computeNextAutoPublishAt(eat, at("2026-01-10T05:59:00Z"))).toEqual(at("2026-01-10T06:00:00Z"));
  });

  test("handles local day boundaries that differ from the UTC day (EAT evening is already the next UTC-day-ish)", () => {
    // 22:30Z on Jan 10 = 01:30 EAT on Jan 11 -> 09:00 EAT Jan 11 = 06:00Z Jan 11
    expect(computeNextAutoPublishAt(eat, at("2026-01-10T22:30:00Z"))).toEqual(at("2026-01-11T06:00:00Z"));
  });

  test("fractional offsets (IST +5:30)", () => {
    const ist = { autoPublishTimeSlots: [6], autoPublishTimezoneOffset: 5.5 };
    // 00:00Z = 05:30 IST -> 06:00 IST = 00:30Z
    expect(computeNextAutoPublishAt(ist, at("2026-01-10T00:00:00Z"))).toEqual(at("2026-01-10T00:30:00Z"));
    // 01:00Z = 06:30 IST -> tomorrow 06:00 IST = 00:30Z next day
    expect(computeNextAutoPublishAt(ist, at("2026-01-10T01:00:00Z"))).toEqual(at("2026-01-11T00:30:00Z"));
  });

  test("negative offsets (PST -8)", () => {
    const pst = { autoPublishTimeSlots: [9], autoPublishTimezoneOffset: -8 };
    // 20:00Z = 12:00 PST on Jan 10 -> Jan 11 09:00 PST = 17:00Z
    expect(computeNextAutoPublishAt(pst, at("2026-01-10T20:00:00Z"))).toEqual(at("2026-01-11T17:00:00Z"));
    // 15:00Z = 07:00 PST -> 09:00 PST same day = 17:00Z
    expect(computeNextAutoPublishAt(pst, at("2026-01-10T15:00:00Z"))).toEqual(at("2026-01-10T17:00:00Z"));
  });

  test("defaults the offset to +3 and prefers slots over the interval", () => {
    const next = computeNextAutoPublishAt({ autoPublishTimeSlots: [9], autoPublishIntervalMs: HOUR }, at("2026-01-10T05:30:00Z"));
    expect(next).toEqual(at("2026-01-10T06:00:00Z"));
  });
});

/** The original Convex implementation, verbatim, as the oracle. */
function legacyNextSlotMs(timeSlots: number[], nowMs: number, timezoneOffsetHours = 3): number {
  const TZ_OFFSET_MS = timezoneOffsetHours * 60 * 60 * 1000;
  const eatMs = nowMs + TZ_OFFSET_MS;
  const eatDate = new Date(eatMs);
  const msSinceEatMidnight =
    eatDate.getUTCHours() * 3_600_000 + eatDate.getUTCMinutes() * 60_000 + eatDate.getUTCSeconds() * 1_000 + eatDate.getUTCMilliseconds();
  const eatMidnightMs = nowMs - msSinceEatMidnight;
  const sorted = [...timeSlots].sort((a, b) => a - b);
  const minFutureMs = nowMs + 60_000;
  for (const h of sorted) {
    const slotMs = eatMidnightMs + h * 3_600_000;
    if (slotMs >= minFutureMs) return slotMs;
  }
  return eatMidnightMs + 24 * 3_600_000 + sorted[0] * 3_600_000;
}

describe("parity with the Convex implementation", () => {
  test("matches on a few thousand random inputs", () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 3000; i++) {
      const nowMs = Date.UTC(2026, 0, 1) + Math.floor(rnd() * 400 * 24 * HOUR);
      const n = 1 + Math.floor(rnd() * 4);
      const slots = Array.from({ length: n }, () => Math.floor(rnd() * 24));
      const tz = [-8, -5, 0, 1, 3, 5.5, 8][Math.floor(rnd() * 7)];
      expect(nextSlotMs(slots, nowMs, tz)).toBe(legacyNextSlotMs(slots, nowMs, tz));
    }
  });
});
