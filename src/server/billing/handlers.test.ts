/**
 * IPN + callback handlers, the billing rpc module and the admin settings modules.
 * Database work happens inside a rolled-back transaction; `fetch` is replaced so neither Pesapal,
 * DeepSeek nor Gemini is ever contacted.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { paymentEvents, paymentOrders, platformSettings, subscriptions } from "@/db/schema";
import { encryptSecret, isEncrypted } from "@/server/crypto";
import { GEMINI_MODEL } from "@/server/lib/ai/metadata";
import { callRpc, inRolledBackTx } from "@/server/testing";
import { createCheckout } from "./core";
import { handleCallback } from "./pesapal/callback";
import { handleIpn, type NotificationDeps } from "./pesapal/ipn";
import { getProvider } from "./service";
import { completed, fakeProvider, getOrder, getUser, mkDeps, resetUser } from "./testkit";
import type { PaymentProvider } from "./types";
import { parseNotification } from "./verify";

setDefaultTimeout(120_000);

const APP = "https://app.test";
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ["NEXT_PUBLIC_APP_URL", "PLAN_ELITE_PRICE", "PLAN_PRO_PRICE", "PESAPAL_CURRENCY"]) saved[k] = process.env[k];
  process.env.NEXT_PUBLIC_APP_URL = APP;
  process.env.PLAN_ELITE_PRICE = "49";
  delete process.env.PLAN_PRO_PRICE;
  delete process.env.PESAPAL_CURRENCY;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const ipnReq = (qs: string, init?: RequestInit) => new Request(`${APP}/api/webhooks/pesapal/ipn?${qs}`, init);
const cbReq = (qs: string) => new Request(`${APP}/api/billing/callback?${qs}`);
const depsFor = (db: DbLike, provider: PaymentProvider | null): NotificationDeps => ({ db, getProvider: async () => provider });

async function openCheckout(tx: DbLike, userId: string, plan: "pro" | "elite" = "pro") {
  await resetUser(tx, userId, "free", "default");
  const co = await createCheckout(tx, { userId, plan, purpose: "initial" }, mkDeps(fakeProvider()));
  return getOrder(tx, co.orderId);
}

const eventsFor = (tx: DbLike, tracking: string) => tx.select().from(paymentEvents).where(eq(paymentEvents.orderTrackingId, tracking));

/** Swap globalThis.fetch for a router; always restored. */
async function withFetch<T>(router: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>, fn: (calls: { url: URL; init: RequestInit | undefined }[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push({ url, init });
    return router(url, init);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyOf = (init?: RequestInit) => (init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
const header = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

/** A scripted Pesapal sandbox. */
function pesapalRouter(opts: { status?: (tracking: string, merchantRef: string) => Record<string, unknown>; ipnList?: { url: string; ipn_id: string }[] } = {}) {
  const orders = new Map<string, string>(); // tracking -> merchant ref
  const router = (url: URL, init: RequestInit | undefined): Response => {
    const path = url.pathname.replace("/pesapalv3", "");
    if (path === "/api/Auth/RequestToken") return json({ token: "tok", expiryDate: new Date(Date.now() + 290_000).toISOString(), error: null, status: "200" });
    if (path === "/api/URLSetup/GetIpnList") return json((opts.ipnList ?? []).map((i) => ({ ...i, error: null, status: "200" })));
    if (path === "/api/URLSetup/RegisterIPN") return json({ url: bodyOf(init).url, ipn_id: "ipn-guid-new", error: null, status: "200" });
    if (path === "/api/Transactions/SubmitOrderRequest") {
      const b = bodyOf(init);
      const tracking = randomUUID();
      orders.set(tracking, String(b.id));
      return json({ order_tracking_id: tracking, merchant_reference: b.id, redirect_url: `https://cybqa.pesapal.com/pesapaliframe/Index/?OrderTrackingId=${tracking}`, error: null, status: "200" });
    }
    if (path === "/api/Transactions/GetTransactionStatus") {
      const tracking = url.searchParams.get("orderTrackingId") ?? "";
      const ref = orders.get(tracking) ?? "unknown";
      return json(opts.status ? opts.status(tracking, ref) : { status_code: 0, merchant_reference: ref, amount: 0, currency: "", error: null, status: "200" });
    }
    return new Response("not found", { status: 404 });
  };
  return { router, orders };
}

async function seedPlatformSettings(tx: DbLike, extra: Partial<typeof platformSettings.$inferInsert> = {}) {
  const values = { id: 1, pesapalConsumerKey: encryptSecret("ck_test_key"), pesapalConsumerSecret: encryptSecret("cs_test_secret"), pesapalEnvironment: "sandbox" as const, pesapalIpnId: "ipn-guid-1", pesapalIpnUrl: `${APP}/api/webhooks/pesapal/ipn`, ...extra };
  await tx.insert(platformSettings).values(values).onConflictDoUpdate({ target: platformSettings.id, set: values });
}

// ─── notification parsing ────────────────────────────────────────────────────

describe("parseNotification", () => {
  const T = "7e6b62d9-883e-440f-a63e-e1105bbfadc3";
  test("accepts Pesapal 3.0 names, legacy aliases and merges query + body", () => {
    expect(parseNotification([{ OrderTrackingId: T, OrderMerchantReference: "in_x", OrderNotificationType: "IPNCHANGE" }])).toEqual({ orderTrackingId: T, merchantRef: "in_x", notificationType: "IPNCHANGE" });
    expect(parseNotification([{ pesapal_transaction_tracking_id: T, pesapal_merchant_reference: "in_x" }])?.orderTrackingId).toBe(T);
    expect(parseNotification([{ OrderMerchantReference: "in_x" }, { OrderTrackingId: T }])?.orderTrackingId).toBe(T);
  });
  test("rejects anything without a plausible tracking id or with hostile characters", () => {
    expect(parseNotification([{}])).toBeNull();
    expect(parseNotification([{ OrderTrackingId: "x" }])).toBeNull();
    expect(parseNotification([{ OrderTrackingId: "a'; drop table users;--" }])).toBeNull();
    expect(parseNotification([{ OrderTrackingId: "a".repeat(200) }])).toBeNull();
    expect(parseNotification([{ OrderTrackingId: T, OrderMerchantReference: "has space/../" }])).toBeNull();
    expect(parseNotification([{ OrderTrackingId: 12345678 as unknown as string }])).toBeNull();
  });
});

// ─── IPN ─────────────────────────────────────────────────────────────────────

describe("IPN endpoint", () => {
  test("stores the raw notification first, verifies with the provider, applies, and answers with Pesapal's JSON", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await openCheckout(tx, user.id);
      const p = fakeProvider();
      p.statuses.set(order.orderTrackingId as string, completed(order));
      const res = await handleIpn(ipnReq(`OrderTrackingId=${order.orderTrackingId}&OrderMerchantReference=${order.merchantRef}&OrderNotificationType=IPNCHANGE`), depsFor(tx, p));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ orderNotificationType: "IPNCHANGE", orderTrackingId: order.orderTrackingId, orderMerchantReference: order.merchantRef, status: 200 });
      expect(p.statusCalls).toEqual([order.orderTrackingId as string]);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
      const events = await eventsFor(tx, order.orderTrackingId as string);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ notificationType: "IPNCHANGE", error: null });
      expect(events[0].processedAt).not.toBeNull();
      expect(events[0].payload).toMatchObject({ source: "ipn", raw: { method: "GET" } });
      expect(JSON.stringify(events[0].payload)).toContain(order.orderTrackingId as string); // the raw query is kept verbatim

      // Pesapal retries / sends a second notification: still 200, nothing changes
      const again = await handleIpn(ipnReq(`OrderTrackingId=${order.orderTrackingId}&OrderMerchantReference=${order.merchantRef}&OrderNotificationType=IPNCHANGE`), depsFor(tx, p));
      expect(again.status).toBe(200);
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, user.id));
      expect(sub.status).toBe("active");
    });
  });

  test("GET query, POST JSON and POST form bodies are all understood", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await openCheckout(tx, user.id);
      const p = fakeProvider();
      p.statuses.set(order.orderTrackingId as string, completed(order, { statusCode: 0, amount: 0 }));
      const t = order.orderTrackingId as string;
      const viaJson = await handleIpn(ipnReq("", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ OrderTrackingId: t, OrderMerchantReference: order.merchantRef, OrderNotificationType: "IPNCHANGE" }) }), depsFor(tx, p));
      const viaForm = await handleIpn(ipnReq("", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `OrderTrackingId=${t}&OrderNotificationType=IPNCHANGE` }), depsFor(tx, p));
      const viaQueryOnPost = await handleIpn(ipnReq(`OrderTrackingId=${t}`, { method: "POST", body: "" }), depsFor(tx, p));
      expect([viaJson.status, viaForm.status, viaQueryOnPost.status]).toEqual([200, 200, 200]);
      expect(p.statusCalls).toHaveLength(3);
      expect((await eventsFor(tx, t)).length).toBe(3);
    });
  });

  test("unknown tracking ids are recorded but never sent to Pesapal; garbage is rejected with 400 (and kept for audit)", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const p = fakeProvider();
      const forged = randomUUID();
      const res = await handleIpn(ipnReq(`OrderTrackingId=${forged}&OrderMerchantReference=in_nope`), depsFor(tx, p));
      expect(res.status).toBe(200);
      expect(p.statusCalls).toHaveLength(0);
      const events = await eventsFor(tx, forged);
      expect(events).toHaveLength(1);
      expect(events[0].error).toBe("unknown_order");

      // Unparseable requests are rejected with 400 but the raw request is still kept for audit.
      const before = (await tx.select().from(paymentEvents).where(eq(paymentEvents.notificationType, "IPN"))).length;
      const bad = await handleIpn(ipnReq("OrderTrackingId=%27%3B%20drop&pesapal_x=1"), depsFor(tx, p));
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { status: number }).status).toBe(400);
      const stored = (await tx.select().from(paymentEvents).where(eq(paymentEvents.notificationType, "IPN"))).filter((e) => e.error === "invalid_params");
      expect(stored.length).toBeGreaterThanOrEqual(1);
      expect((await tx.select().from(paymentEvents).where(eq(paymentEvents.notificationType, "IPN"))).length).toBe(before + 1);
      expect(stored[0]).toMatchObject({ orderTrackingId: null, merchantRef: null });
      expect(JSON.stringify(stored[0].payload)).toContain("drop");
      expect(p.statusCalls).toHaveLength(0);
      const huge = await handleIpn(ipnReq("", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(20_000) }) }), depsFor(tx, p));
      expect(huge.status).toBe(413);
    });
  });

  test("a forged IPN for a real order cannot grant anything unless Pesapal says it was paid", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await openCheckout(tx, user.id);
      const p = fakeProvider();
      p.statuses.set(order.orderTrackingId as string, completed(order, { statusCode: 0, amount: 0 })); // Pesapal: still unpaid
      const res = await handleIpn(ipnReq(`OrderTrackingId=${order.orderTrackingId}&OrderMerchantReference=${order.merchantRef}&OrderNotificationType=COMPLETED&status=1&status_code=1&payment_status_description=Completed`), depsFor(tx, p));
      expect(res.status).toBe(200);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });
      expect((await getOrder(tx, order.id)).appliedAt).toBeNull();
    });
  });

  test("a provider outage is still acknowledged (reconcile settles it later); the failure is on the event row", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await openCheckout(tx, user.id);
      const p = fakeProvider(); // no status scripted -> getStatus throws
      const res = await handleIpn(ipnReq(`OrderTrackingId=${order.orderTrackingId}`), depsFor(tx, p));
      expect(res.status).toBe(200);
      const [ev] = await eventsFor(tx, order.orderTrackingId as string);
      expect(ev.error).toStartWith("verify_failed");
      expect(ev.processedAt).not.toBeNull();

      const unconfigured = await handleIpn(ipnReq(`OrderTrackingId=${order.orderTrackingId}`), depsFor(tx, null));
      expect(unconfigured.status).toBe(200);
    });
  });

  test("only a failure to STORE the notification answers 500 (so Pesapal retries)", async () => {
    const brokenDb = new Proxy({} as DbLike, {
      get() {
        return () => {
          throw new Error("db down");
        };
      },
    });
    const res = await handleIpn(ipnReq(`OrderTrackingId=${randomUUID()}`), { db: brokenDb, getProvider: async () => fakeProvider() });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { status: number }).status).toBe(500);
  });
});

// ─── customer callback ───────────────────────────────────────────────────────

describe("callback endpoint", () => {
  const location = (r: Response) => r.headers.get("location");

  test("verifies server-side and redirects: success / pending / failed", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await openCheckout(tx, user.id);
      const t = order.orderTrackingId as string;
      const p = fakeProvider();
      const q = `OrderTrackingId=${t}&OrderMerchantReference=${order.merchantRef}&OrderNotificationType=CALLBACKURL`;

      p.statuses.set(t, completed(order, { statusCode: 0, amount: 0 }));
      let r = await handleCallback(cbReq(q), depsFor(tx, p));
      expect(r.status).toBe(303);
      expect(location(r)).toBe(`${APP}/billing?status=pending`);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });

      p.statuses.set(t, completed(order, { statusCode: 2 }));
      r = await handleCallback(cbReq(q), depsFor(tx, p));
      expect(location(r)).toBe(`${APP}/billing?status=failed`);

      p.statuses.set(t, completed(order));
      r = await handleCallback(cbReq(q), depsFor(tx, p));
      expect(location(r)).toBe(`${APP}/billing?status=success`);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
      expect(r.headers.get("cache-control")).toBe("no-store");

      // a second visit (back button, refresh) is still "success" and changes nothing
      r = await handleCallback(cbReq(q), depsFor(tx, p));
      expect(location(r)).toBe(`${APP}/billing?status=success`);
    });
  });

  test("never grants from the query string, and a forged id lands on 'failed'", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await openCheckout(tx, user.id);
      const t = order.orderTrackingId as string;
      const p = fakeProvider();
      p.statuses.set(t, completed(order, { statusCode: 0, amount: 0 }));
      const r = await handleCallback(cbReq(`OrderTrackingId=${t}&status=success&payment_status_description=Completed&status_code=1&amount=19`), depsFor(tx, p));
      expect(location(r)).toBe(`${APP}/billing?status=pending`);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });

      const forged = await handleCallback(cbReq(`OrderTrackingId=${randomUUID()}&OrderMerchantReference=in_nope`), depsFor(tx, p));
      expect(location(forged)).toBe(`${APP}/billing?status=failed`);
      const none = await handleCallback(cbReq(""), depsFor(tx, p));
      expect(location(none)).toBe(`${APP}/billing?status=failed`);
      expect(location(await handleCallback(cbReq(`OrderTrackingId=${t}`), depsFor(tx, null)))).toBe(`${APP}/billing?status=pending`);
      expect(location(await handleCallback(cbReq(`OrderTrackingId=${t}`), depsFor(tx, fakeProvider())))).toBe(`${APP}/billing?status=pending`); // provider outage
    });
  });

  test("an amount mismatch lands on 'failed' and grants nothing", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await openCheckout(tx, user.id);
      const t = order.orderTrackingId as string;
      const p = fakeProvider();
      p.statuses.set(t, completed(order, { amount: 0.01 }));
      const r = await handleCallback(cbReq(`OrderTrackingId=${t}`), depsFor(tx, p));
      expect(location(r)).toBe(`${APP}/billing?status=failed`);
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });
    });
  });
});

// ─── billing rpc (real provider adapter over a mocked Pesapal) ───────────────

describe("billing rpc", () => {
  test("checkout -> IPN -> status, end to end against a scripted Pesapal", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      await seedPlatformSettings(tx);
      const pesapal = pesapalRouter({
        status: (tracking, ref) => ({ status_code: 1, payment_status_description: "Completed", merchant_reference: ref, amount: 19, currency: "USD", confirmation_code: "ABC123", payment_method: "MPESA", error: null, status: "200" }),
      });
      await withFetch(pesapal.router, async (calls) => {
        const before = (await callRpc("billing.getStatus", {}, { user, tx })) as Record<string, unknown>;
        expect(before).toMatchObject({ plan: "free", paymentsEnabled: true, currency: "USD", selfServe: true, prices: { pro: 19, elite: 49 } });
        expect("subscription" in before).toBe(false);

        const { redirectUrl } = (await callRpc("billing.createCheckout", { plan: "pro" }, { user, tx })) as { redirectUrl: string };
        expect(redirectUrl).toStartWith("https://cybqa.pesapal.com/");

        const submit = calls.find((c) => c.url.pathname.endsWith("SubmitOrderRequest"));
        expect(header(submit?.init, "Authorization")).toBe("Bearer tok");
        expect(bodyOf(submit?.init)).toMatchObject({ currency: "USD", amount: 19, notification_id: "ipn-guid-1", callback_url: `${APP}/api/billing/callback`, billing_address: { email_address: user.email } });
        // nothing granted yet
        expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });

        // Pesapal calls our IPN; the real provider adapter re-fetches the status over the (mocked) API
        const [order] = await tx.select().from(paymentOrders).where(eq(paymentOrders.userId, user.id));
        const res = await handleIpn(ipnReq(`OrderTrackingId=${order.orderTrackingId}&OrderMerchantReference=${order.merchantRef}&OrderNotificationType=IPNCHANGE`), { db: tx, getProvider });
        expect(res.status).toBe(200);
        expect(calls.some((c) => c.url.pathname.endsWith("GetTransactionStatus"))).toBe(true);

        const after = (await callRpc("billing.getStatus", {}, { user, tx })) as Record<string, unknown>;
        expect(after).toMatchObject({ plan: "pro", subscription: { status: "active", plan: "pro", cancelAtPeriodEnd: false } });
        const wire = JSON.stringify(after);
        for (const forbidden of ["orderTrackingId", "confirmationCode", "redirectUrl", "merchantRef", "ABC123", order.merchantRef, order.orderTrackingId as string]) expect(wire).not.toContain(forbidden);
        const payments = (await callRpc("billing.listPayments", {}, { user, tx })) as { status: string; paymentMethod?: string; amount: number }[];
        expect(payments).toHaveLength(1);
        expect(payments[0]).toMatchObject({ status: "paid", paymentMethod: "MPESA", amount: 19 });

        // cancel / resume
        expect(await callRpc("billing.cancel", {}, { user, tx })).toHaveProperty("endsAt");
        expect(await callRpc("billing.getStatus", {}, { user, tx })).toMatchObject({ subscription: { cancelAtPeriodEnd: true } });
        await callRpc("billing.resume", {}, { user, tx });
        expect(await callRpc("billing.getStatus", {}, { user, tx })).toMatchObject({ subscription: { cancelAtPeriodEnd: false } });
      });
    });
  });

  test("every function is scoped to the caller and needs a session", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const order = await openCheckout(tx, user.id);
      void order;
      const stranger = { ...user, id: randomUUID(), email: "stranger@example.test" };
      expect(await callRpc("billing.listPayments", {}, { user: stranger, tx })).toEqual([]);
      expect(await callRpc("billing.getStatus", {}, { user: stranger, tx })).toMatchObject({ plan: "free", payments: [] });
      await expect(callRpc("billing.cancel", {}, { user: stranger, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("billing.getStatus", {}, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(callRpc("billing.createCheckout", { plan: "pro" }, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(callRpc("billing.createCheckout", { plan: "free" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  test("an unconfigured install fails with a readable message, not 'Internal error'", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "free", "default");
      const originalKey = process.env.PESAPAL_CONSUMER_KEY;
      delete process.env.PESAPAL_CONSUMER_KEY;
      try {
        await tx.insert(platformSettings).values({ id: 1 }).onConflictDoUpdate({ target: platformSettings.id, set: { pesapalConsumerKey: null, pesapalConsumerSecret: null } });
        await expect(callRpc("billing.createCheckout", { plan: "pro" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("aren't set up") });
        expect(await callRpc("billing.getStatus", {}, { user, tx })).toMatchObject({ paymentsEnabled: false });
      } finally {
        if (originalKey !== undefined) process.env.PESAPAL_CONSUMER_KEY = originalKey;
      }
    });
  });
});

// ─── admin: platform settings + API key tests ────────────────────────────────

describe("admin.platformSettings", () => {
  test("getStatus returns booleans and masked hints only; secrets are encrypted at rest", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      await callRpc(
        "admin.platformSettings.update",
        { pesapalConsumerKey: "ck_PLAINTEXT_KEY_123456", pesapalConsumerSecret: "cs_PLAINTEXT_SECRET_987654", deepseekApiKey: "sk-ds-PLAINTEXT-AAAA", geminiApiKey: "AIza-PLAINTEXT-BBBB", pesapalEnvironment: "live" },
        { user: admin, tx },
      );
      const status = await callRpc("admin.platformSettings.getStatus", {}, { user: admin, tx });
      const wire = JSON.stringify(status);
      for (const secret of ["PLAINTEXT", "ck_PLAINTEXT_KEY_123456", "cs_PLAINTEXT_SECRET_987654", "v1:"]) expect(wire).not.toContain(secret);
      expect(status).toMatchObject({ deepseekKeySet: true, geminiKeySet: true, pesapalConfigured: true, pesapalConsumerSecretSet: true, pesapalEnvironment: "live", pesapalIpnRegistered: false });
      expect(Object.values(status as Record<string, unknown>).every((v) => typeof v === "boolean" || typeof v === "string")).toBe(true);

      const [row] = await tx.select().from(platformSettings).where(eq(platformSettings.id, 1));
      for (const col of [row.pesapalConsumerKey, row.pesapalConsumerSecret, row.deepseekApiKey, row.geminiApiKey]) {
        expect(isEncrypted(col)).toBe(true);
        expect(col).not.toContain("PLAINTEXT");
      }

      // empty string clears
      await callRpc("admin.platformSettings.update", { deepseekApiKey: "" }, { user: admin, tx });
      expect(await callRpc("admin.platformSettings.getStatus", {}, { user: admin, tx })).toMatchObject({ deepseekKeySet: false, geminiKeySet: true });
    });
  });

  test("changing the environment or consumer key invalidates the registered IPN id", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      await seedPlatformSettings(tx, { pesapalEnvironment: "sandbox" });
      expect(await callRpc("admin.platformSettings.getStatus", {}, { user: admin, tx })).toMatchObject({ pesapalIpnRegistered: true });
      await callRpc("admin.platformSettings.update", { pesapalConsumerSecret: "rotated-secret" }, { user: admin, tx });
      expect(await callRpc("admin.platformSettings.getStatus", {}, { user: admin, tx })).toMatchObject({ pesapalIpnRegistered: true }); // secret rotation keeps it
      await callRpc("admin.platformSettings.update", { pesapalEnvironment: "sandbox" }, { user: admin, tx });
      expect(await callRpc("admin.platformSettings.getStatus", {}, { user: admin, tx })).toMatchObject({ pesapalIpnRegistered: true }); // same value, no change
      await callRpc("admin.platformSettings.update", { pesapalEnvironment: "live" }, { user: admin, tx });
      expect(await callRpc("admin.platformSettings.getStatus", {}, { user: admin, tx })).toMatchObject({ pesapalIpnRegistered: false, pesapalEnvironment: "live" });
      await seedPlatformSettings(tx);
      await callRpc("admin.platformSettings.update", { pesapalConsumerKey: "another-merchant" }, { user: admin, tx });
      expect(await callRpc("admin.platformSettings.getStatus", {}, { user: admin, tx })).toMatchObject({ pesapalIpnRegistered: false });
    });
  });

  test("admin only", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const member = { ...user, isAdmin: false };
      for (const [path, args] of [
        ["admin.platformSettings.getStatus", {}],
        ["admin.platformSettings.update", { geminiApiKey: "x" }],
        ["admin.platformSettings.registerIpn", {}],
        ["admin.platformSettings.getUrls", {}],
        ["admin.testApiKeys.testDeepseek", {}],
        ["admin.testApiKeys.testGemini", {}],
      ] as const) {
        await expect(callRpc(path, args, { user: member, tx })).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(callRpc(path, args, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      }
    });
  });

  test("registerIpn registers once, then reuses the identical registration; local URLs are refused", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      await seedPlatformSettings(tx, { pesapalIpnId: null, pesapalIpnUrl: null });
      const url = `${APP}/api/webhooks/pesapal/ipn`;

      await withFetch(pesapalRouter({ ipnList: [] }).router, async (calls) => {
        expect(await callRpc("admin.platformSettings.registerIpn", {}, { user: admin, tx })).toMatchObject({ ipnUrl: url, reused: false, environment: "sandbox" });
        const reg = calls.find((c) => c.url.pathname.endsWith("RegisterIPN"));
        expect(bodyOf(reg?.init)).toEqual({ url, ipn_notification_type: "GET" });
      });
      const [row] = await tx.select().from(platformSettings).where(eq(platformSettings.id, 1));
      expect(row).toMatchObject({ pesapalIpnId: "ipn-guid-new", pesapalIpnUrl: url });

      await withFetch(pesapalRouter({ ipnList: [{ url, ipn_id: "ipn-existing" }] }).router, async (calls) => {
        expect(await callRpc("admin.platformSettings.registerIpn", {}, { user: admin, tx })).toMatchObject({ reused: true });
        expect(calls.some((c) => c.url.pathname.endsWith("RegisterIPN"))).toBe(false);
      });
      expect((await tx.select().from(platformSettings).where(eq(platformSettings.id, 1)))[0].pesapalIpnId).toBe("ipn-existing");

      process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
      try {
        await withFetch(pesapalRouter().router, async (calls) => {
          await expect(callRpc("admin.platformSettings.registerIpn", {}, { user: admin, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
          expect(calls).toHaveLength(0);
        });
      } finally {
        process.env.NEXT_PUBLIC_APP_URL = APP;
      }
    });
  });
});

describe("admin.testApiKeys", () => {
  const KEY_D = "sk-deepseek-SECRETVALUE-1234";
  const KEY_G = "AIzaSy-GEMINI-SECRETVALUE-5678";

  async function withKeys<T>(fn: (h: { tx: DbLike; admin: Parameters<typeof callRpc>[2]["user"] }) => Promise<T>) {
    return inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      await callRpc("admin.platformSettings.update", { deepseekApiKey: KEY_D, geminiApiKey: KEY_G }, { user: admin, tx });
      return fn({ tx, admin });
    });
  }

  test("DeepSeek: a tiny real request with a timeout; success and failure never echo the key or the provider's body", async () => {
    await withKeys(async ({ tx, admin }) => {
      await withFetch(
        () => json({ choices: [{ message: { content: "OK" } }] }),
        async (calls) => {
          const r = (await callRpc("admin.testApiKeys.testDeepseek", {}, { user: admin, tx })) as { success: boolean; message: string };
          expect(r.success).toBe(true);
          expect(r.message).toContain("OK");
          expect(r.message).not.toContain(KEY_D);
          expect(calls).toHaveLength(1);
          expect(calls[0].url.hostname).toBe("api.deepseek.com");
          expect(header(calls[0].init, "Authorization")).toBe(`Bearer ${KEY_D}`);
          expect(calls[0].init?.signal).toBeDefined();
          expect(bodyOf(calls[0].init)).toMatchObject({ max_tokens: 5 });
        },
      );
      await withFetch(
        () => new Response(`{"error":"invalid key ${KEY_D}"}`, { status: 401 }),
        async () => {
          const r = (await callRpc("admin.testApiKeys.testDeepseek", {}, { user: admin, tx })) as { success: boolean; message: string };
          expect(r.success).toBe(false);
          expect(r.message).toContain("401");
          expect(r.message).not.toContain(KEY_D);
          expect(r.message).not.toContain("invalid key");
        },
      );
      await withFetch(
        () => {
          throw new DOMException("The operation timed out", "TimeoutError");
        },
        async () => {
          const r = (await callRpc("admin.testApiKeys.testDeepseek", {}, { user: admin, tx })) as { success: boolean; message: string };
          expect(r).toMatchObject({ success: false });
          expect(r.message).toContain("did not answer");
        },
      );
    });
  });

  test("Gemini: key in a header (never the URL), current model, safe failures", async () => {
    await withKeys(async ({ tx, admin }) => {
      await withFetch(
        () => json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] }),
        async (calls) => {
          const r = (await callRpc("admin.testApiKeys.testGemini", {}, { user: admin, tx })) as { success: boolean; message: string };
          expect(r.success).toBe(true);
          expect(r.message).not.toContain(KEY_G);
          expect(calls[0].url.hostname).toBe("generativelanguage.googleapis.com");
          expect(calls[0].url.toString()).not.toContain(KEY_G);
          expect(calls[0].url.pathname).toContain(GEMINI_MODEL);
          expect(header(calls[0].init, "x-goog-api-key")).toBe(KEY_G);
        },
      );
      await withFetch(
        () => json({ error: { message: `API key not valid: ${KEY_G}` } }, 400),
        async () => {
          const r = (await callRpc("admin.testApiKeys.testGemini", {}, { user: admin, tx })) as { success: boolean; message: string };
          expect(r.success).toBe(false);
          expect(r.message).not.toContain(KEY_G);
          expect(r.message).not.toContain("not valid");
        },
      );
    });
  });

  test("no key configured -> a clear message and no network call", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const admin = { ...user, isAdmin: true };
      await tx.insert(platformSettings).values({ id: 1 }).onConflictDoUpdate({ target: platformSettings.id, set: { deepseekApiKey: null } });
      await withFetch(
        () => json({}),
        async (calls) => {
          expect(await callRpc("admin.testApiKeys.testDeepseek", {}, { user: admin, tx })).toEqual({ success: false, message: "No DeepSeek key configured." });
          expect(calls).toHaveLength(0);
        },
      );
    });
  });
});
