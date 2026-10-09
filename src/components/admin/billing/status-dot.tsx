import { Flag } from "lucide-react";
import { cn } from "@/lib/utils";
import { flagTone, paymentStatus, subscriptionStatus, type Tone } from "./format";

const DOT: Record<Tone, string> = {
  success: "bg-success",
  pending: "bg-warning",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/60",
};

/** A 6px dot plus its text label. The label carries the meaning; the dot only supports it. */
export function StatusDot({ tone, label, className }: { tone: Tone; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      {label}
    </span>
  );
}

export function PaymentStatus({ payment }: { payment: { statusCode?: number | null } }) {
  const s = paymentStatus(payment);
  return <StatusDot tone={s.tone} label={s.label} />;
}

export function SubscriptionStatus({ status }: { status: string }) {
  const s = subscriptionStatus(status);
  return <StatusDot tone={s.tone} label={s.label} />;
}

/** Plain-text marker for a payment that needs a human. Renders nothing when the payment isn't flagged. */
export function FlagMarker({ payment, className }: { payment: { flag?: string | null; flagLabel?: string | null; reviewedAt?: number | null }; className?: string }) {
  if (!payment.flag || !payment.flagLabel) return null;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium text-foreground", className)}>
      <Flag aria-hidden className="size-3 shrink-0" />
      Flagged: {payment.flagLabel}
      {payment.reviewedAt ? <span className="font-normal text-muted-foreground">(reviewed)</span> : null}
    </span>
  );
}

/** Flag label with its own dot, for the review queue where the flag is the headline. */
export function FlagStatus({ payment }: { payment: { flag?: string | null; flagLabel?: string | null } }) {
  if (!payment.flagLabel) return null;
  return <StatusDot tone={flagTone(payment.flag)} label={payment.flagLabel} />;
}
