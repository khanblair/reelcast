"use client";

import { ConvexReactClient, ConvexProviderWithAuth } from "convex/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SyncUserWithConvex } from "./sync-user-with-convex";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

function useSupabaseAuth() {
  const [isAuthenticated, setAuthenticated] = useState(false);
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setAuthenticated(!!data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setAuthenticated(!!session);
    });
    return () => subscription.unsubscribe();
  }, [supabase]);

  const fetchAccessToken = useCallback(async ({ forceRefreshToken }: { forceRefreshToken: boolean }) => {
    if (forceRefreshToken) await supabase.auth.refreshSession();
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, [supabase]);

  return useMemo(
    () => ({ isLoading: false, isAuthenticated, fetchAccessToken }),
    [isAuthenticated, fetchAccessToken]
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
