"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { LoadingSpinner } from "@/components/shared/loading-spinner";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = useQuery(api.users.current);
  const router = useRouter();

  useEffect(() => {
    if (user === null || (user !== undefined && !user.isAdmin)) {
      router.replace("/dashboard");
    }
  }, [user, router]);

  if (user === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (!user?.isAdmin) return null;

  return <>{children}</>;
}
