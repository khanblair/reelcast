"use client";

import Link from "next/link";
import type { Route } from "next";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { formatMoney } from "@/components/billing/plans";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, RpcClientError, useMutation } from "@/lib/rpc/client";
import { CopyButton } from "./copy-button";
import { formatDateTime, paymentTitle, userHref, type BillingPayment } from "./format";
import { FlagStatus } from "./status-dot";

const NOTE_MAX = 500;

/**
 * One flagged payment in the review queue: who paid, what went wrong, what to do, the code to look up in the
 * Pesapal dashboard, and a note plus "Mark as reviewed". Reviewed payments render read-only.
 */
export function ReviewItem({ payment: p, onOpenDetails }: { payment: BillingPayment; onOpenDetails: (id: string) => void }) {
  const markReviewed = useMutation(api.admin.billing.markReviewed);
  const queryClient = useQueryClient();
  const noteId = useId();
  const errorId = useId();
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    const trimmed = note.trim();
    try {
      await markReviewed({ id: p._id, ...(trimmed ? { note: trimmed } : {}) });
    } catch (e) {
      if (e instanceof RpcClientError && e.code === "CONFLICT") {
        // Someone else already reviewed it: nothing to tell the admin, just refresh the queue.
        await queryClient.invalidateQueries({ queryKey: ["rpc"] });
      } else {
        setError(e instanceof Error ? e.message : "Couldn't mark this payment as reviewed. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="rounded-lg border border-border bg-card" aria-label={`${p.flagLabel ?? "Flagged"} payment from ${p.email}`}>
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border px-4 py-3 sm:px-5">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">
            <FlagStatus payment={p} />
          </p>
          <p className="truncate text-sm">
            <Link href={userHref(p.userId) as Route} className="underline-offset-4 hover:underline">
              {p.email}
            </Link>
            {p.name ? <span className="text-muted-foreground"> · {p.name}</span> : null}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">{formatMoney(p.amount, p.currency)}</p>
          <p className="text-xs tabular-nums text-muted-foreground">{formatDateTime(p.createdAt)}</p>
        </div>
      </header>

      <div className="grid gap-5 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {p.guidance ? <p className="max-w-prose text-sm text-muted-foreground text-pretty">{p.guidance}</p> : null}
          <dl className="space-y-2 text-sm">
            <Ref label="Payment">{paymentTitle(p)}</Ref>
            {p.confirmationCode ? (
              <Ref label="Confirmation code">
                <span className="flex items-center gap-1">
                  <code className="break-all font-mono text-xs">{p.confirmationCode}</code>
                  <CopyButton value={p.confirmationCode} label="confirmation code" />
                </span>
              </Ref>
            ) : (
              <Ref label="Confirmation code">
                <span className="text-muted-foreground">Not provided by Pesapal</span>
              </Ref>
            )}
            {!p.confirmationCode && p.orderTrackingId ? (
              <Ref label="Tracking ID">
                <span className="flex items-center gap-1">
                  <code className="break-all font-mono text-xs">{p.orderTrackingId}</code>
                  <CopyButton value={p.orderTrackingId} label="tracking ID" />
                </span>
              </Ref>
            ) : null}
          </dl>
          <Button variant="ghost" size="sm" className="-ml-3" onClick={() => onOpenDetails(p._id)}>
            View payment details
          </Button>
        </div>

        {p.reviewedAt ? (
          <div className="space-y-1 text-sm lg:border-l lg:border-border lg:pl-5">
            <p className="font-medium">Reviewed</p>
            <p className="text-xs tabular-nums text-muted-foreground">{formatDateTime(p.reviewedAt)}{p.reviewedByEmail ? ` · ${p.reviewedByEmail}` : ""}</p>
            {p.reviewNote ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{p.reviewNote}</p> : <p className="text-muted-foreground">No note.</p>}
          </div>
        ) : (
          <form
            className="space-y-2 lg:border-l lg:border-border lg:pl-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={noteId} className="text-sm font-medium">
                Note <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {note.length}/{NOTE_MAX}
              </span>
            </div>
            <Textarea
              id={noteId}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={NOTE_MAX}
              rows={2}
              placeholder="For example: refunded in Pesapal"
              className="min-h-[64px] resize-y"
              disabled={pending}
              aria-describedby={error ? errorId : undefined}
            />
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
              Mark as reviewed
            </Button>
          </form>
        )}
      </div>
    </article>
  );
}

function Ref({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Same footprint as `ReviewItem`, for the loading state. */
export function ReviewItemSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card" role="status" aria-label="Loading payment">
      <div className="flex items-start justify-between gap-6 border-b border-border px-4 py-3 sm:px-5">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="space-y-2">
          <Skeleton className="ml-auto h-6 w-20" />
          <Skeleton className="ml-auto h-3 w-28" />
        </div>
      </div>
      <div className="grid gap-5 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-3">
          <Skeleton className="h-4 w-full max-w-prose" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-8 w-36" />
        </div>
      </div>
    </div>
  );
}
