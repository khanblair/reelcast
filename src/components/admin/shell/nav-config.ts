import {
  BarChart3,
  ClipboardCheck,
  CreditCard,
  Film,
  Gauge,
  HardDrive,
  HeartPulse,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Receipt,
  Repeat,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * Single source of truth for the admin console navigation. The sidebar renders it, and the top bar derives
 * its breadcrumb from it, so a page only has to be listed here once.
 */

export type NavBadge = "needsReview";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Active only on this exact path (used where the href is a prefix of sibling items, e.g. Overview and Billing). */
  exact?: boolean;
  /** Marks an item that shows a live count (resolved by the sidebar). */
  badge?: NavBadge;
};

export type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

export const ADMIN_NAV: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [{ label: "Overview", href: "/admin", icon: LayoutDashboard, exact: true }],
  },
  {
    id: "people",
    label: "People",
    items: [
      { label: "Users", href: "/admin/users", icon: Users },
      { label: "Messages", href: "/admin/contact", icon: MessageSquare },
    ],
  },
  {
    id: "content",
    label: "Content",
    items: [
      { label: "Videos", href: "/admin/videos", icon: Film },
      { label: "Jobs", href: "/admin/jobs", icon: ListChecks },
    ],
  },
  {
    id: "money",
    label: "Money",
    items: [
      { label: "Billing", href: "/admin/billing", icon: CreditCard, exact: true },
      { label: "Subscriptions", href: "/admin/billing/subscriptions", icon: Repeat },
      { label: "Payments", href: "/admin/billing/payments", icon: Receipt },
      { label: "Needs review", href: "/admin/billing/review", icon: ClipboardCheck, badge: "needsReview" },
      { label: "Usage", href: "/admin/usage", icon: BarChart3 },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { label: "Quota", href: "/admin/system/quota", icon: Gauge },
      { label: "Storage", href: "/admin/system/storage", icon: HardDrive },
      { label: "Health", href: "/admin/system/health", icon: HeartPulse },
      { label: "Settings", href: "/admin/settings", icon: Settings },
    ],
  },
];

/** True when the group's only item repeats the group name (Overview), so its label would be redundant. */
export function isSelfLabelledGroup(group: NavGroup): boolean {
  return group.items.length === 1 && group.items[0].label === group.label;
}

function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function matches(item: NavItem, path: string): boolean {
  if (item.exact) return path === item.href;
  return path === item.href || path.startsWith(`${item.href}/`);
}

export type NavMatch = {
  group: NavGroup;
  item: NavItem;
  /** True when the path is below the item's own page (e.g. /admin/users/<id>), so the breadcrumb adds a detail crumb. */
  isDetail: boolean;
};

/**
 * The nav item that owns `pathname`: the longest matching href wins, so /admin/billing/payments/<id> belongs to
 * Payments (not Billing) and /admin/users/<id> belongs to Users. Returns null for paths not in the config.
 */
export function resolveNavMatch(pathname: string): NavMatch | null {
  const path = normalize(pathname);
  let best: NavMatch | null = null;
  for (const group of ADMIN_NAV) {
    for (const item of group.items) {
      if (!matches(item, path)) continue;
      if (!best || item.href.length > best.item.href.length) {
        best = { group, item, isDetail: path !== item.href };
      }
    }
  }
  return best;
}
