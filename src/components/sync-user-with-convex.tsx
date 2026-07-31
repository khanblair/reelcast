"use client";

import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export function SyncUserWithConvex() {
  const storeUser = useMutation(api.users.store);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) storeUser().catch(console.error);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
