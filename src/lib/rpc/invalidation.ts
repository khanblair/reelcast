/**
 * Which cached queries a write must refresh.
 *
 * Query keys are ["rpc", path, args] (see client.ts). TanStack matches a partial key by ARRAY PREFIX,
 * element by element, so ["rpc", "notifications.get"] matches ["rpc", "notifications.get", {}] but
 * never ["rpc", "notifications.getX", {}]: always use a FULL path string as the second element.
 *
 * The default is the safe one: a write that is not in the table invalidates every query. A path
 * belongs here only when the server code behind it provably changes nothing but the data of the
 * listed queries (check the module AND every other query that reads the same tables). Anything that
 * touches users, settings, billing, channels, videos, jobs, the queue, publishing or generation feeds
 * several views (and publish/generation create notifications), so those must stay out of this table.
 *
 * Pure module: no React, no "use client", so it is unit-testable.
 */
import type { QueryClient } from "@tanstack/react-query";

export type QueryKeyPrefix = readonly ["rpc", string];

const key = (path: string): QueryKeyPrefix => ["rpc", path];

/** Everything that stops being true once one of these queries is stale, e.g. the bell's unread dot. */
const NOTIFICATIONS: readonly QueryKeyPrefix[] = [key("notifications.get")];

/** ideas.list is the only reader of the `ideas` table (the ideas page); no stats or dashboard query counts ideas. */
const IDEAS: readonly QueryKeyPrefix[] = [key("ideas.list")];

/** Assistant panel: the session list (order, titles) and the open conversation. Deleting a session cascades to its messages. */
const AI_CHAT: readonly QueryKeyPrefix[] = [key("aiSessions.list"), key("aiMessages.getContext")];

/**
 * Every query that reads usage_ledger, which `chat` increments (consumeQuota). Only billing.getStatus is
 * on screen (the billing page); the rest are listed so a cached copy can never serve a stale counter.
 * Invalidating a query nobody is observing costs no request.
 */
const USAGE_READERS: readonly QueryKeyPrefix[] = [
  key("billing.getStatus"),
  key("usageLedger.getUsageSummary"),
  key("admin.usageLedger.getOverview"),
  key("admin.usageLedger.getSummary"),
];

const TABLE: ReadonlyMap<string, readonly QueryKeyPrefix[]> = new Map([
  ["notifications.markAsRead", NOTIFICATIONS],
  ["notifications.markAllAsRead", NOTIFICATIONS],
  ["notifications.clearAll", NOTIFICATIONS],

  ["ideas.create", IDEAS],
  ["ideas.update", IDEAS],
  ["ideas.remove", IDEAS],
  ["ideas.linkVideo", IDEAS],

  ["aiSessions.create", AI_CHAT],
  ["aiSessions.updateTitle", AI_CHAT],
  ["aiSessions.remove", AI_CHAT],
  // aiMessages has no writes (getContext is its only export).

  // The chat action stores both turns, bumps the session's lastMessageAt and consumes one unit of the
  // aiMessagesUsed quota. It writes nothing else (no notification, no users/settings row).
  ["actions.aiAssistant.chat", [...AI_CHAT, ...USAGE_READERS]],
]);

/** The query-key prefixes to invalidate after `path` resolves, or undefined = invalidate everything. */
export function invalidationFor(path: string): readonly QueryKeyPrefix[] | undefined {
  return TABLE.get(path);
}

/** Every write path that has a narrowed invalidation (for tests and audits). */
export function narrowedWritePaths(): string[] {
  return [...TABLE.keys()];
}

/** Awaitable, so callers see fresh data once their write resolves. */
export async function invalidateForWrite(qc: Pick<QueryClient, "invalidateQueries">, path: string): Promise<void> {
  const keys = invalidationFor(path);
  if (!keys) {
    await qc.invalidateQueries({ queryKey: ["rpc"] });
    return;
  }
  await Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey })));
}
