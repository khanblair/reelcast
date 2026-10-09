/**
 * Client-safe plan copy and formatting helpers. NO server imports and NO env reads here: prices
 * and the charge currency come from the server (`billing.getStatus`), so the browser never
 * disagrees with what Pesapal will actually charge. The server-side counterpart is
 * src/server/billing/plans.ts, which re-uses the constants below.
 */

export type PlanKey = "free" | "pro" | "elite";
export type PaidPlanKey = "pro" | "elite";

export const PLAN_RANK: Record<PlanKey, number> = { free: 0, pro: 1, elite: 2 };
export const PLAN_NAMES: Record<PlanKey, string> = { free: "Free", pro: "Pro", elite: "Elite" };

/** One paid period (renewals are manual one-off payments, not auto-debits). */
export const PERIOD_DAYS = 30;
/** Access continues this long after a missed renewal before the plan lapses. */
export const GRACE_DAYS = 3;
/** The renewal reminder and the "Renew now" button open this many days before the period ends. */
export const RENEWAL_LEAD_DAYS = 3;
/** usage limits at or above this are rendered as "unlimited" (mirrors server UNLIMITED). */
export const UNLIMITED_THRESHOLD = 999_999;

export type PlanCopy = {
  key: PlanKey;
  name: string;
  tagline: string;
  features: string[];
  highlight?: boolean;
};

export const PLAN_COPY: PlanCopy[] = [
  {
    key: "free",
    name: "Free",
    tagline: "Forever free, no card required",
    features: [
      "10 video uploads / month",
      "5 AI metadata generations / month",
      "No AI video generation",
      "No AI chat assistant",
      "YouTube publishing & basic scheduling",
    ],
  },
  {
    key: "pro",
    name: "Pro",
    tagline: "For serious creators",
    features: [
      "Unlimited video uploads",
      "Unlimited AI metadata generations",
      "5 AI video generations (Veo) / month",
      "200 AI assistant messages / month",
      "Auto-publish queue, full analytics, Discord/Telegram/email alerts",
    ],
    highlight: true,
  },
  {
    key: "elite",
    name: "Elite",
    tagline: "For power creators",
    features: [
      "Unlimited video uploads",
      "Unlimited AI metadata generations",
      "Unlimited AI video generations (Veo)",
      "1000 AI assistant messages / month",
      "Everything in Pro",
    ],
  },
];

export const USAGE_LABELS: Record<string, string> = {
  videosUploaded: "Video uploads",
  metadataGenerated: "AI metadata generations",
  veoGenerated: "AI video generations (Veo)",
  aiMessagesUsed: "AI assistant messages",
};

export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  approval_pending: "Awaiting payment",
  active: "Active",
  past_due: "Payment overdue",
  cancelled: "Cancelled",
  expired: "Expired",
};

/** "$19", "$19.50", "KES 2,500". Falls back to "<CODE> <amount>" for unknown currency codes. */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function formatDate(ms?: number | null): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
