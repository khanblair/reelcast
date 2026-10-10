import { describe, expect, test } from "bun:test";
import { UNREADABLE_USER, sessionUserId, shouldClearQueryCache, trackedUserIdAfter } from "./auth-cache";

const A = "user-a";
const B = "user-b";

describe("shouldClearQueryCache", () => {
  test("a refocus SIGNED_IN for the same user keeps the cache", () => {
    expect(shouldClearQueryCache({ event: "SIGNED_IN", previousUserId: A, nextUserId: A })).toBe(false);
  });

  test("SIGNED_IN as a different user clears (account isolation, e.g. switched in another tab)", () => {
    expect(shouldClearQueryCache({ event: "SIGNED_IN", previousUserId: A, nextUserId: B })).toBe(true);
  });

  test("SIGNED_OUT always clears, whatever was tracked", () => {
    expect(shouldClearQueryCache({ event: "SIGNED_OUT", previousUserId: A, nextUserId: null })).toBe(true);
    expect(shouldClearQueryCache({ event: "SIGNED_OUT", previousUserId: null, nextUserId: null })).toBe(true);
    expect(shouldClearQueryCache({ event: "SIGNED_OUT", previousUserId: undefined, nextUserId: null })).toBe(true);
  });

  test("the first event after load only seeds the id (nothing to compare with)", () => {
    expect(shouldClearQueryCache({ event: "SIGNED_IN", previousUserId: undefined, nextUserId: A })).toBe(false);
    expect(shouldClearQueryCache({ event: "INITIAL_SESSION", previousUserId: undefined, nextUserId: A })).toBe(false);
    expect(shouldClearQueryCache({ event: "INITIAL_SESSION", previousUserId: undefined, nextUserId: null })).toBe(false);
  });

  test("after seeding, a refocus SIGNED_IN and an INITIAL_SESSION replay keep the cache", () => {
    expect(shouldClearQueryCache({ event: "INITIAL_SESSION", previousUserId: A, nextUserId: A })).toBe(false);
    expect(shouldClearQueryCache({ event: "SIGNED_IN", previousUserId: A, nextUserId: A })).toBe(false);
  });

  test("TOKEN_REFRESHED / USER_UPDATED for the same user keep the cache", () => {
    expect(shouldClearQueryCache({ event: "TOKEN_REFRESHED", previousUserId: A, nextUserId: A })).toBe(false);
    expect(shouldClearQueryCache({ event: "USER_UPDATED", previousUserId: A, nextUserId: A })).toBe(false);
  });

  test("any event carrying a different user clears, even TOKEN_REFRESHED (cross-tab broadcast)", () => {
    expect(shouldClearQueryCache({ event: "TOKEN_REFRESHED", previousUserId: A, nextUserId: B })).toBe(true);
  });

  test("signed out -> signed in clears, so signed-out answers do not outlive the sign-in", () => {
    expect(shouldClearQueryCache({ event: "SIGNED_IN", previousUserId: null, nextUserId: A })).toBe(true);
  });

  test("an unreadable user id fails toward isolation, even before seeding", () => {
    expect(shouldClearQueryCache({ event: "SIGNED_IN", previousUserId: A, nextUserId: UNREADABLE_USER })).toBe(true);
    expect(shouldClearQueryCache({ event: "SIGNED_IN", previousUserId: undefined, nextUserId: UNREADABLE_USER })).toBe(true);
    expect(shouldClearQueryCache({ event: "SIGNED_IN", previousUserId: UNREADABLE_USER, nextUserId: A })).toBe(true);
  });
});

describe("tracked id across a sequence of events", () => {
  function replay(events: { event: string; userId: string | null }[], seed?: string | null) {
    let tracked: string | null | undefined = seed;
    const clears: boolean[] = [];
    for (const { event, userId } of events) {
      clears.push(shouldClearQueryCache({ event, previousUserId: tracked, nextUserId: userId }));
      tracked = trackedUserIdAfter({ event, nextUserId: userId });
    }
    return { clears, tracked };
  }

  test("load, refocus, refocus, token refresh: never clears", () => {
    const { clears } = replay([
      { event: "SIGNED_IN", userId: A }, // init chain, before getSession() resolved
      { event: "INITIAL_SESSION", userId: A },
      { event: "SIGNED_IN", userId: A }, // refocus
      { event: "TOKEN_REFRESHED", userId: A },
      { event: "SIGNED_IN", userId: A }, // refocus
    ]);
    expect(clears).toEqual([false, false, false, false, false]);
  });

  test("seeded from getSession(): the first refocus does not clear", () => {
    expect(replay([{ event: "SIGNED_IN", userId: A }], A).clears).toEqual([false]);
  });

  test("sign out then sign in as someone else clears twice and ends tracking the new user", () => {
    const { clears, tracked } = replay(
      [
        { event: "SIGNED_OUT", userId: null },
        { event: "SIGNED_IN", userId: B },
        { event: "SIGNED_IN", userId: B }, // refocus as B
      ],
      A,
    );
    expect(clears).toEqual([true, true, false]);
    expect(tracked).toBe(B);
  });

  test("signing out then back in as the same account still clears", () => {
    const { clears } = replay(
      [
        { event: "SIGNED_OUT", userId: null },
        { event: "SIGNED_IN", userId: A },
      ],
      A,
    );
    expect(clears).toEqual([true, true]);
  });

  test("a visitor who signs in: seed null, then SIGNED_IN clears once and refocus does not", () => {
    const { clears } = replay(
      [
        { event: "INITIAL_SESSION", userId: null },
        { event: "SIGNED_IN", userId: A },
        { event: "SIGNED_IN", userId: A },
      ],
    );
    expect(clears).toEqual([false, true, false]);
  });
});

describe("sessionUserId", () => {
  test("reads the id, and null for no session", () => {
    expect(sessionUserId({ user: { id: A } })).toBe(A);
    expect(sessionUserId(null)).toBeNull();
    expect(sessionUserId(undefined)).toBeNull();
  });

  test("a session without a readable id is UNREADABLE_USER, not a crash", () => {
    expect(sessionUserId({ user: null })).toBe(UNREADABLE_USER);
    expect(sessionUserId({ user: {} })).toBe(UNREADABLE_USER);
    const throwing = new Proxy({}, { get: () => { throw new Error("user not available"); } });
    expect(sessionUserId({ user: throwing as { id?: unknown } })).toBe(UNREADABLE_USER);
  });
});
