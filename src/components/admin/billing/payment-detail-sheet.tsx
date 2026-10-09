"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState, type ReactNode } from "react";
import { formatMoney } from "@/components/billing/plans";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { api, useQuery } from "@/lib/rpc/client";
import type { ReturnOf } from "@/lib/rpc/types";
import { CopyButton } from "./copy-button";
import { flagTone, formatDateTime, paymentTitle, userHref, type BillingPayment } from "./format";
import { PaymentStatus, StatusDot } from "./status-dot";

/**
 * Right-hand panel with everything about one payment: references, amounts, the notification trail from
 * Pesapal and, when the payment is flagged, what to do about it. `paymentId` null means closed.
 */
export function PaymentDetailSheet({ paymentId, onClose }: { paymentId: string | null; onClose: () => void }) {
  // Keep the last id while the panel animates closed so the content doesn't flash to a skeleton.
  const [shownId, setShownId] = useState<string | null>(paymentId);
  if (paymentId !== null && paymentId !== shownId) setShownId(paymentId);

  const detail = useQuery(api.admin.billing.getPayment, shownId ? { id: shownId } : "skip");

  return (
    <Sheet open={paymentId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="pr-6">
          <SheetTitle>Payment details</SheetTitle>
          <SheetDescription>
            {detail ? `${detail.payment.email} · ${formatDateTime(detail.payment.createdAt) ?? ""}` : detail === null ? "Payment not found" : "Loading payment"}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-6" aria-busy={detail === undefined}>
          {detail === undefined ? (
            <DetailSkeleton />
          ) : detail === null ? (
            <p className="text-sm text-muted-foreground">This payment no longer exists. It may have been removed with its customer.</p>
          ) : (
            <Detail payment={detail.payment} events={detail.events} onNavigate={onClose} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type PaymentEvent = NonNullable<ReturnOf<typeof api.admin.billing.getPayment>>["events"][number];

function Detail({ payment: p, events, onNavigate }: { payment: BillingPayment; events: PaymentEvent[]; onNavigate: () => void }) {
  return (
    <div className="space-y-6">
      <section aria-label="Summary" className="space-y-2">
        <p className="text-3xl font-semibold tracking-tight tabular-nums">{formatMoney(p.amount, p.currency)}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <PaymentStatus payment={p} />
          <span className="text-muted-foreground">{paymentTitle(p)}</span>
          {p.paymentMethod ? <span className="text-muted-foreground">{p.paymentMethod}</span> : null}
        </div>
      </section>

      {p.flag && p.flagLabel ? (
        <section aria-label="Flag" className="space-y-2 rounded-md border border-border bg-secondary/40 p-3">
          <p className="text-sm font-medium">
            <StatusDot tone={flagTone(p.flag)} label={`Flagged: ${p.flagLabel}`} />
          </p>
          {p.guidance ? <p className="text-sm text-muted-foreground text-pretty">{p.guidance}</p> : null}
          {p.reviewedAt ? (
            <p className="text-sm">
              Reviewed {formatDateTime(p.reviewedAt)}{p.reviewedByEmail ? ` by ${p.reviewedByEmail}` : ""}
              {p.reviewNote ? <span className="text-muted-foreground">. Note: {p.reviewNote}</span> : null}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Not reviewed yet. Refund it in the Pesapal dashboard, then mark it reviewed in the{" "}
              <Link href={"/admin/billing/review" as Route} onClick={onNavigate} className="text-foreground underline underline-offset-4">
                Needs review queue
              </Link>
              .
            </p>
          )}
        </section>
      ) : null}

      <section aria-labelledby="payment-refs" className="space-y-1">
        <h3 id="payment-refs" className="text-sm font-semibold">
          References
        </h3>
        <dl className="divide-y divide-border">
          <RefRow label="Confirmation code" value={p.confirmationCode} hint="Search for this in the Pesapal dashboard." />
          <RefRow label="Tracking ID" value={p.orderTrackingId} />
          <RefRow label="Merchant reference" value={p.merchantRef} />
        </dl>
      </section>

      <section aria-labelledby="payment-details" className="space-y-1">
        <h3 id="payment-details" className="text-sm font-semibold">
          Details
        </h3>
        <dl className="divide-y divide-border">
          <Row label="Customer">
            <Link href={userHref(p.userId) as Route} onClick={onNavigate} className="break-all underline underline-offset-4 hover:text-foreground">
              {p.email}
            </Link>
            {p.name ? <p className="text-xs text-muted-foreground">{p.name}</p> : null}
          </Row>
          <Row label="Created">
            <span className="tabular-nums">{formatDateTime(p.createdAt) ?? "—"}</span>
          </Row>
          <Row label="Applied to plan">
            {p.appliedAt ? <span className="tabular-nums">{formatDateTime(p.appliedAt)}</span> : <span className="text-muted-foreground">Not applied</span>}
          </Row>
          {p.statusText ? (
            <Row label="Pesapal status">
              <span className="break-all">{p.statusText}</span>
            </Row>
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="payment-events" className="space-y-2">
        <h3 id="payment-events" className="text-sm font-semibold">
          Notifications from Pesapal
        </h3>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notifications received yet. Pesapal sends one when the payment status changes.</p>
        ) : (
          <ol className="divide-y divide-border rounded-md border border-border">
            {events.map((e) => (
              <li key={e._id} className="space-y-0.5 px-3 py-2 text-sm">
                <p className="font-medium">{e.notificationType}</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  Received {formatDateTime(e.receivedAt) ?? "—"}
                  {" · "}
                  {e.processedAt ? `Processed ${formatDateTime(e.processedAt)}` : "Not processed"}
                </p>
                {e.error ? <p className="break-words text-xs text-destructive">{e.error}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function RefRow({ label, value, hint }: { label: string; value?: string | null; hint?: string }) {
  return (
    <Row label={label}>
      {value ? (
        <div className="flex items-center justify-between gap-2">
          <code className="min-w-0 break-all font-mono text-xs">{value}</code>
          <CopyButton value={value} label={label.toLowerCase()} />
        </div>
      ) : (
        <span className="text-muted-foreground">Not available</span>
      )}
      {value && hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </Row>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading payment">
      <div className="space-y-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-4 w-56" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-24" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-20" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}
