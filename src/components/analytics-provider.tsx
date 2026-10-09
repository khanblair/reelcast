"use client";

/**
 * Product analytics (PostHog). Mount once, INSIDE <Providers> (it uses the auth state and the
 * RPC query client), e.g. in the root layout.
 *
 * Env: NEXT_PUBLIC_POSTHOG_KEY (required to enable; absent = complete no-op),
 *      NEXT_PUBLIC_POSTHOG_HOST (optional, default https://eu.i.posthog.com).
 *
 * Privacy: identifies with the internal user id ONLY (never email or name), honours
 * Do-Not-Track, keeps person profiles for identified users only, no session recording, and no
 * autocapture of form inputs (clicks on links/buttons only).
 */
import posthog from "posthog-js";
import { useEffect, useRef, type ReactNode } from "react";
import { useAuthState } from "@/components/providers";
import { api, useQuery } from "@/lib/rpc/client";

let initialised = false;

function initPosthog(): boolean {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || typeof window === "undefined") return false;
  if (initialised) return true;
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com",
    capture_pageview: "history_change",
    person_profiles: "identified_only",
    respect_dnt: true,
    disable_session_recording: true,
    session_recording: { maskAllInputs: true },
    autocapture: {
      dom_event_allowlist: ["click"],
      element_allowlist: ["a", "button"],
    },
  });
  initialised = true;
  return true;
}

export default function AnalyticsProvider({ children }: { children?: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuthState();
  const me = useQuery(api.users.current, isAuthenticated ? undefined : "skip");
  const userId = me?._id;
  const identified = useRef<string | null>(null);

  // Initialise once on the client (no-op without a key).
  useEffect(() => {
    initPosthog();
  }, []);

  // Identify with the user id only; reset when the session ends.
  useEffect(() => {
    if (!initialised) return;
    if (userId && identified.current !== userId) {
      posthog.identify(userId);
      identified.current = userId;
    } else if (!isLoading && !isAuthenticated && identified.current) {
      posthog.reset();
      identified.current = null;
    }
  }, [userId, isAuthenticated, isLoading]);

  return <>{children}</>;
}
