"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { ReactNode } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

import { SyncUserWithConvex } from "./sync-user-with-convex";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <NextThemesProvider attribute="class" defaultTheme="dark" enableSystem>
          <SyncUserWithConvex />
          {children}
        </NextThemesProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
