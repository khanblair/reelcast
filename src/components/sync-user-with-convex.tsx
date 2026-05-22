"use client";

import { useUser } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useEffect } from "react";

export function SyncUserWithConvex() {
  const { user, isLoaded, isSignedIn } = useUser();
  const storeUser = useMutation(api.users.store);

  useEffect(() => {
    if (isLoaded && isSignedIn) {
      storeUser().catch(console.error);
    }
  }, [isLoaded, isSignedIn, user?.id, storeUser]);

  return null;
}
