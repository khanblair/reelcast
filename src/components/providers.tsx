"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { sessionUserId, shouldClearQueryCache, trackedUserIdAfter } from "@/lib/auth-cache";
import { createClient } from "@/lib/supabase/client";

type AuthState = { isLoading: boolean; isAuthenticated: boolean };
const AuthContext = createContext<AuthState>({ isLoading: true, isAuthenticated: false });

/** Replaces `useConvexAuth()`. */
export function useAuthState() {
  return useContext(AuthContext);
}

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, refetchOnWindowFocus: true },
        },
      }),
  );
  const [auth, setAuth] = useState<AuthState>({ isLoading: true, isAuthenticated: false });
  const supabase = useMemo(() => createClient(), []);
  // Whose data the query cache holds. undefined = not seeded yet, null = signed out (see lib/auth-cache.ts).
  const cacheUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // Returns the same state object when nothing changed, so React skips the re-render (and the context
    // consumers with it). auth-js re-announces the session on every tab refocus.
    const applyAuth = (isAuthenticated: boolean) =>
      setAuth((prev) => (!prev.isLoading && prev.isAuthenticated === isAuthenticated ? prev : { isLoading: false, isAuthenticated }));

    supabase.auth.getSession().then(({ data }) => {
      // Seed only: a newer auth event may already have recorded who is signed in.
      if (cacheUserId.current === undefined) cacheUserId.current = sessionUserId(data.session);
      applyAuth(!!data.session);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // Never show one account's cached data to the next account. Clear when the signed-in user
      // CHANGES (or signs out), not on every SIGNED_IN: auth-js emits SIGNED_IN each time a hidden tab
      // becomes visible again, and clearing there refetched everything on every refocus.
      const nextUserId = sessionUserId(session);
      if (shouldClearQueryCache({ event, previousUserId: cacheUserId.current, nextUserId })) queryClient.clear();
      cacheUserId.current = trackedUserIdAfter({ event, nextUserId });
      applyAuth(!!session);
    });

    // When the browser restores a page from bfcache (back/forward navigation),
    // React state is frozen at the moment it was cached. Force a reload so
    // auth state is fresh rather than stale from a previous sign-out.
    function handlePageShow(e: PageTransitionEvent) {
      if (e.persisted) window.location.reload();
    }
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      subscription.unsubscribe();
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [supabase, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem>
          {children}
        </NextThemesProvider>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}
