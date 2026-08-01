"use client";

import { ConvexReactClient, ConvexProviderWithAuth } from "convex/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SyncUserWithConvex } from "./sync-user-with-convex";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

function useSupabaseAuth() {
  const [isAuthenticated, setAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuthenticated(!!data.session);
      setIsLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setAuthenticated(!!session);
      setIsLoading(false);
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
  }, [supabase]);

  const fetchAccessToken = useCallback(async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    if (forceRefreshToken) await supabase.auth.refreshSession();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    // Exchange Supabase session for our own RS256-signed JWT that Convex can validate
    const res = await fetch("/api/auth/token");
    if (!res.ok) return null;
    const { token } = await res.json();
    return token as string;
  }, [supabase]);

  return useMemo(
    () => ({ isLoading, isAuthenticated, fetchAccessToken }),
    [isLoading, isAuthenticated, fetchAccessToken]
  );
}

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ConvexProviderWithAuth client={convex} useAuth={useSupabaseAuth}>
      <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem>
        <SyncUserWithConvex />
        {children}
      </NextThemesProvider>
    </ConvexProviderWithAuth>
  );
}
