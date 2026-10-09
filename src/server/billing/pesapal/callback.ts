/**
 * Browser return from the Pesapal payment page. The query string only says WHICH order; it is never
 * trusted for the outcome. We verify with GetTransactionStatus, apply, and redirect to
 * /billing?status=success|failed|pending. No session is required: the apply is idempotent and keyed
 * on the order we stored, not on who is asking.
 */
import { appUrlFrom } from "../service";
import { markNotificationProcessed, parseNotification, recordNotification, verifyAndApply } from "../verify";
import type { NotificationDeps } from "./ipn";

export type ReturnStatus = "success" | "failed" | "pending";

export async function handleCallback(req: Request, deps: NotificationDeps): Promise<Response> {
  const { db } = deps;
  const n = parseNotification([Object.fromEntries(new URL(req.url).searchParams)]);
  let status: ReturnStatus = "failed";

  if (n) {
    let eventId: string | null = null;
    try {
      eventId = await recordNotification(db, n, "callback", { OrderTrackingId: n.orderTrackingId, OrderMerchantReference: n.merchantRef ?? null, OrderNotificationType: n.notificationType ?? null });
    } catch {
      // auditing must not block the user's return
    }
    let error: string | null = null;
    try {
      const provider = await deps.getProvider(db);
      if (!provider) {
        status = "pending";
        error = "payments_not_configured";
      } else {
        const r = await verifyAndApply(db, provider, n);
        if (r.outcome === "applied" || r.outcome === "already_applied") status = "success";
        else if (r.outcome === "pending") status = "pending";
        else status = "failed";
        if (r.outcome === "unknown_order") error = "unknown_order";
        else if (r.outcome === "rejected") error = `rejected:${r.reason ?? "unknown"}`;
      }
    } catch (e) {
      status = "pending"; // provider unreachable: the IPN / reconcile sweep will settle it
      error = `verify_failed: ${(e instanceof Error ? e.message : "unknown error").slice(0, 200)}`;
    }
    if (eventId) await markNotificationProcessed(db, eventId, error).catch(() => undefined);
  }

  const location = `${appUrlFrom(req)}/billing?status=${status}`;
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}
