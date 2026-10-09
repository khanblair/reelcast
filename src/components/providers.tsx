"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuth({ isLoading: false, isAuthenticated: !!data.session });
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      setAuth({ isLoading: false, isAuthenticated: !!session });
      // Never show one account's cached data to the next account.
      if (event === "SIGNED_OUT" || event === "SIGNED_IN") queryClient.clear();
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
