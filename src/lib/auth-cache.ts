/**
 * When must the React Query cache be thrown away because the signed-in account changed?
 *
 * Supabase (auth-js) fires `SIGNED_IN` far more often than "a user signed in": its
 * visibilitychange handler calls `_recoverAndRefresh`, which re-announces `SIGNED_IN` every time a
 * hidden tab becomes visible again. The listener used to `clear()` on every `SIGNED_IN`, so each tab
 * refocus emptied the cache (spinner flash, a burst of refetches, polling observers reset).
 *
 * The cache only holds one account's data, so the right question is "did the user id change?",
 * not "which event fired?".
 *
 * Tracked user id, as kept by the caller:
 *   undefined  not seeded yet (no session read, no auth event seen)
 *   null       known to be signed out
 *   string     the signed-in user's id (or UNREADABLE_USER)
 */

/** Stands in for a session whose user id could not be read (auth-js can hand out a throwing proxy user). */
export const UNREADABLE_USER = "\u0000unreadable-user";

type SessionLike = { user?: { id?: unknown } | null } | null | undefined;

/** The user id of an auth-js session, null when signed out. Never throws. */
export function sessionUserId(session: SessionLike): string | null {
  if (!session) return null;
  try {
    const id = session.user?.id;
    return typeof id === "string" && id.length > 0 ? id : UNREADABLE_USER;
  } catch {
    return UNREADABLE_USER;
  }
}

export function shouldClearQueryCache(input: {
  event: string;
  /** The id seen before this event (see the legend above). */
  previousUserId: string | null | undefined;
  /** The id carried by this event's session (null = no session). */
  nextUserId: string | null;
}): boolean {
  const { event, previousUserId, nextUserId } = input;
  if (event === "SIGNED_OUT") return true;
  // Fail toward account isolation: if we cannot tell who this is, drop everything.
  if (nextUserId === UNREADABLE_USER) return true;
  // First thing we hear about the session: nothing to compare with, only seed. The cache was empty
  // when the app mounted, and queries started since then ran under the same cookie session.
  if (previousUserId === undefined) return false;
  // Same account (a refocus SIGNED_IN, TOKEN_REFRESHED, INITIAL_SESSION replay, USER_UPDATED): keep it.
  // A different account, or signed-out -> signed-in (signed-out answers such as `[]` must not outlive
  // the sign-in), arrives here as a changed id. This also covers another tab switching accounts,
  // because auth-js re-emits that tab's events here through its BroadcastChannel.
  return previousUserId !== nextUserId;
}

/** The id to remember after an event: whatever the event's session says; SIGNED_OUT always means signed out. */
export function trackedUserIdAfter(input: { event: string; nextUserId: string | null }): string | null {
  return input.event === "SIGNED_OUT" ? null : input.nextUserId;
}
