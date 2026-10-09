"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { AdminPage } from "@/components/admin/shell/admin-page";

/**
 * Error boundary for every admin page. It renders inside the admin layout, so the sidebar and top bar stay usable
 * when a page's query or render fails.
 */
export default function AdminError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  // RPC queries throw into this boundary (throwOnError). Without resetting the query error state first, a retry
  // would re-throw the cached error instead of refetching.
  const { reset: resetQueryErrors } = useQueryErrorResetBoundary();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <AdminPage title="Something went wrong">
      <div className="flex flex-col items-start gap-4 rounded-lg border p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium">This page could not be loaded.</p>
            <p className="max-w-prose text-sm text-muted-foreground">
              {error.message || "An unexpected error occurred."} The rest of the console is still available from the sidebar.
            </p>
            {error.digest ? <p className="text-xs text-muted-foreground">Error ID: {error.digest}</p> : null}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            resetQueryErrors();
            unstable_retry();
          }}
        >
          Try again
        </Button>
      </div>
    </AdminPage>
  );
}
