/**
 * Pesapal IPN endpoint logic (kept out of the route file so it can be tested).
 *
 * The IPN has NO signature and carries only OrderTrackingId / OrderMerchantReference /
 * OrderNotificationType, so it is treated as a hint: the raw request (capped) is stored first, then
 * the real status is fetched from Pesapal (GetTransactionStatus) and applied idempotently.
 *
 * Response contract (Pesapal docs): JSON { orderNotificationType, orderTrackingId,
 * orderMerchantReference, status: 200 }. Only a failure to STORE the notification answers 500, so
 * Pesapal retries; every other failure is recorded on the event row and picked up by the
 * reconcile sweep.
 */
import type { DbLike } from "@/db/client";
import type { PaymentProvider } from "../types";
import { markNotificationProcessed, parseNotification, recordNotification, verifyAndApply, type Notification } from "../verify";

export type NotificationDeps = {
  db: DbLike;
  getProvider: (db: DbLike) => Promise<PaymentProvider | null>;
};

const MAX_BODY_BYTES = 16_384;

class TooLarge extends Error {}

type RawRequest = { sources: Record<string, unknown>[]; query: string; body: string };

async function readRequest(req: Request): Promise<RawRequest> {
  const url = new URL(req.url);
  const sources: Record<string, unknown>[] = [Object.fromEntries(url.searchParams)];
  const out: RawRequest = { sources, query: url.search.slice(0, 2_000), body: "" };
  if (req.method === "GET" || req.method === "HEAD") return out;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new TooLarge();
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new TooLarge();
  out.body = text.slice(0, 4_000);
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    sources.push(Object.fromEntries(new URLSearchParams(text)));
  } else if (text.trim().startsWith("{")) {
    try {
      const json: unknown = JSON.parse(text);
      if (json && typeof json === "object" && !Array.isArray(json)) sources.push(json as Record<string, unknown>);
    } catch {
      // not JSON: ignore the body, the query string may still carry the parameters
    }
  }
  return out;
}

function reply(n: Pick<Notification, "orderTrackingId" | "merchantRef" | "notificationType"> | null, status: number): Response {
  return Response.json(
    {
      orderNotificationType: n?.notificationType ?? "IPNCHANGE",
      orderTrackingId: n?.orderTrackingId ?? "",
      orderMerchantReference: n?.merchantRef ?? "",
      status,
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleIpn(req: Request, deps: NotificationDeps): Promise<Response> {
  const { db } = deps;
  let raw: RawRequest;
  try {
    raw = await readRequest(req);
  } catch (e) {
    return reply(null, e instanceof TooLarge ? 413 : 400);
  }
  const n = parseNotification(raw.sources);

  // Audit first, before anything can reject or fail: the capped raw query/body is kept even when it
  // does not parse (an id format we did not anticipate is exactly when you want the evidence).
  let eventId: string;
  try {
    eventId = await recordNotification(db, n, "ipn", { method: req.method, query: raw.query, body: raw.body });
  } catch (e) {
    console.error("[pesapal ipn] could not store notification", e instanceof Error ? e.message : "unknown error");
    return reply(n, 500);
  }
  if (!n) {
    await markNotificationProcessed(db, eventId, "invalid_params").catch(() => undefined);
    return reply(null, 400);
  }

  let error: string | null = null;
  try {
    const provider = await deps.getProvider(db);
    if (!provider) {
      error = "payments_not_configured";
    } else {
      const r = await verifyAndApply(db, provider, n);
      if (r.outcome === "unknown_order") error = "unknown_order";
      else if (r.outcome === "rejected") error = `rejected:${r.reason ?? "unknown"}`;
    }
  } catch (e) {
    // Provider outage etc.: the reconcile sweep will retry, so still acknowledge receipt.
    error = `verify_failed: ${(e instanceof Error ? e.message : "unknown error").slice(0, 200)}`;
    console.error("[pesapal ipn] verification failed", error);
  }
  await markNotificationProcessed(db, eventId, error).catch(() => undefined);
  return reply(n, 200);
}
