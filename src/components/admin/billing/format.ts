import type { api } from "@/lib/rpc/client";
import type { ReturnOf } from "@/lib/rpc/types";
import { PLAN_NAMES, SUBSCRIPTION_STATUS_LABELS, type PlanKey } from "@/components/billing/plans";

/** One payment as the admin API returns it (ids arrive as `_id`, null fields are omitted). */
export type BillingPayment = ReturnOf<typeof api.admin.billing.listPayments>["rows"][number];
export type BillingSubscription = ReturnOf<typeof api.admin.billing.listSubscriptions>["rows"][number];

/** success = green, pending = amber, danger = red, neutral = muted. Always paired with a text label. */
export type Tone = "success" | "pending" | "danger" | "neutral";

export const planLabel = (plan?: string | null): string => PLAN_NAMES[(plan ?? "free") as PlanKey] ?? plan ?? "Free";

/** Date and time, for events and payments. Epoch-ms in, plain text out. */
export function formatDateTime(ms?: number | null): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function paymentStatus(p: { statusCode?: number | null }): { label: string; tone: Tone } {
  switch (p.statusCode) {
    case 1:
      return { label: "Completed", tone: "success" };
    case 2:
      return { label: "Failed", tone: "danger" };
    case 3:
      return { label: "Reversed", tone: "danger" };
    default:
      return { label: "Pending", tone: "pending" };
  }
}

const PURPOSE_LABELS: Record<string, string> = { initial: "New subscription", renewal: "Renewal", upgrade: "Upgrade" };

/** "Renewal · Pro" */
export function paymentTitle(p: { purpose: string; plan: string }): string {
  return `${PURPOSE_LABELS[p.purpose] ?? p.purpose} · ${planLabel(p.plan)}`;
}

export function flagTone(flag?: string | null): Tone {
  return flag === "reversed" ? "danger" : "pending";
}

export function subscriptionStatus(status: string): { label: string; tone: Tone } {
  const label = SUBSCRIPTION_STATUS_LABELS[status] ?? status;
  switch (status) {
    case "active":
      return { label, tone: "success" };
    case "approval_pending":
      return { label, tone: "pending" };
    case "past_due":
      return { label, tone: "danger" };
    default:
      return { label, tone: "neutral" };
  }
}

/** How the user's current plan came to be, as plain text. */
export function planSourceLabel(source?: string | null): string {
  if (source === "admin") return "Set by admin";
  if (source === "subscription") return "Via subscription";
  return "Default";
}

export const userHref = (userId: string) => `/admin/users/${userId}`;
