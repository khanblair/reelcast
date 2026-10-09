/**
 * Pesapal client: no network, no DB. `fetch` is replaced by a URL router.
 */
import { describe, expect, test } from "bun:test";
import { createPesapalClient, createTokenCache, parsePesapalDate, PesapalError, TOKEN_REFRESH_SKEW_MS, type PesapalClientOptions, type PesapalCredentials } from "./client";

const CREDS: PesapalCredentials = { consumerKey: "test-key", consumerSecret: "test-secret", environment: "sandbox" };

type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };
type Handler = (call: Call, n: number) => { status?: number; json?: unknown; text?: string };

function mockFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const counts: Record<string, number> = {};
  const fetchImpl: NonNullable<PesapalClientOptions["fetch"]> = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { method, path: url.pathname + url.search, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    counts[key] = (counts[key] ?? 0) + 1;
    const h = routes[key];
    if (!h) return new Response("not found", { status: 404 });
    const out = h(call, counts[key]);
    return new Response(out.text ?? JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls, counts };
}

/** RequestToken handler that issues "tok-<n>" valid for `ttlMs` (Pesapal's 7-digit fractional format). */
const tokenRoute = (nowFn: () => number, ttlMs = 5 * 60_000): Handler => (_c, n) => ({
  json: { token: `tok-${n}`, expiryDate: new Date(nowFn() + ttlMs).toISOString().replace("Z", "4567Z"), error: null, status: "200", message: "Request processed successfully" },
});

const STATUS_PATH = "GET /pesapalv3/api/Transactions/GetTransactionStatus";
const TOKEN_PATH = "POST /pesapalv3/api/Auth/RequestToken";

function setup(routes: Record<string, Handler>, clock = { t: 1_700_000_000_000 }) {
  const m = mockFetch({ [TOKEN_PATH]: tokenRoute(() => clock.t), ...routes });
  const client = createPesapalClient(CREDS, { fetch: m.fetchImpl, now: () => clock.t, cache: createTokenCache() });
  return { ...m, client, clock };
}

const completed = { status_code: 1, payment_status_description: "Completed", merchant_reference: "in_x", amount: 19, currency: "USD", confirmation_code: "ABC", payment_method: "MPESA", error: null, status: "200" };

describe("parsePesapalDate", () => {
  test("handles 7 fractional digits, plain Z and missing zone", () => {
    expect(parsePesapalDate("2021-08-26T12:29:30.5177702Z")).toBe(Date.parse("2021-08-26T12:29:30.517Z"));
    expect(parsePesapalDate("2021-08-26T12:29:30Z")).toBe(Date.parse("2021-08-26T12:29:30Z"));
    expect(parsePesapalDate("2021-08-26T12:29:30.5")).toBe(Date.parse("2021-08-26T12:29:30.500Z"));
  });
  test("garbage is NaN, never a throw", () => {
    expect(parsePesapalDate("yesterday")).toBeNaN();
    expect(parsePesapalDate(null)).toBeNaN();
  });
});

describe("token cache", () => {
  test("one RequestToken serves many calls and the bearer token is sent", async () => {
    const { client, counts, calls } = setup({ [STATUS_PATH]: () => ({ json: completed }) });
    await client.getTransactionStatus("trk-1");
    await client.getTransactionStatus("trk-2");
    expect(counts[TOKEN_PATH]).toBe(1);
    const statusCalls = calls.filter((c) => c.path.includes("GetTransactionStatus"));
    expect(statusCalls.every((c) => c.headers.authorization === "Bearer tok-1")).toBe(true);
    expect(statusCalls[0].path).toContain("orderTrackingId=trk-1");
    // the token request itself carries no bearer and sends the documented body
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body).toEqual({ consumer_key: "test-key", consumer_secret: "test-secret" });
  });

  test("refreshes ~30s before expiry", async () => {
    const { client, counts, clock } = setup({ [STATUS_PATH]: () => ({ json: completed }) });
    await client.getTransactionStatus("trk-1");
    clock.t += 5 * 60_000 - TOKEN_REFRESH_SKEW_MS - 1_000; // still fresh
    await client.getTransactionStatus("trk-1");
    expect(counts[TOKEN_PATH]).toBe(1);
    clock.t += 2_000; // inside the 30s skew
    await client.getTransactionStatus("trk-1");
    expect(counts[TOKEN_PATH]).toBe(2);
  });

  test("concurrent callers share a single token request", async () => {
    const { client, counts } = setup({ [STATUS_PATH]: () => ({ json: completed }) });
    await Promise.all([client.getTransactionStatus("a"), client.getTransactionStatus("b"), client.getTransactionStatus("c")]);
    expect(counts[TOKEN_PATH]).toBe(1);
  });

  test("a bogus far-future expiry is capped at the documented 5 minutes", async () => {
    const clock = { t: 1_700_000_000_000 };
    const m = mockFetch({
      [TOKEN_PATH]: (_c, n) => ({ json: { token: `tok-${n}`, expiryDate: "2999-01-01T00:00:00Z", error: null, status: "200" } }),
      [STATUS_PATH]: () => ({ json: completed }),
    });
    const client = createPesapalClient(CREDS, { fetch: m.fetchImpl, now: () => clock.t, cache: createTokenCache() });
    await client.getTransactionStatus("x");
    clock.t += 5 * 60_000;
    await client.getTransactionStatus("x");
    expect(m.counts[TOKEN_PATH]).toBe(2);
  });

  test("an unparsable expiry falls back to a short ttl instead of caching forever", async () => {
    const clock = { t: 1_700_000_000_000 };
    const m = mockFetch({
      [TOKEN_PATH]: (_c, n) => ({ json: { token: `tok-${n}`, expiryDate: "not a date", error: null, status: "200" } }),
      [STATUS_PATH]: () => ({ json: completed }),
    });
    const client = createPesapalClient(CREDS, { fetch: m.fetchImpl, now: () => clock.t, cache: createTokenCache() });
    await client.getTransactionStatus("x");
    clock.t += 45_000;
    await client.getTransactionStatus("x");
    expect(m.counts[TOKEN_PATH]).toBe(2);
  });

  test("credentials and environment key the cache", async () => {
    const cache = createTokenCache();
    const m = mockFetch({ [TOKEN_PATH]: (_c, n) => ({ json: { token: `tok-${n}`, expiryDate: new Date(Date.now() + 240_000).toISOString(), error: null, status: "200" } }), [STATUS_PATH]: () => ({ json: completed }) });
    const a = createPesapalClient(CREDS, { fetch: m.fetchImpl, cache });
    const b = createPesapalClient({ ...CREDS, consumerSecret: "rotated" }, { fetch: m.fetchImpl, cache });
    await a.getTransactionStatus("x");
    await b.getTransactionStatus("x");
    expect(m.counts[TOKEN_PATH]).toBe(2);
  });
});

describe("401 handling", () => {
  test("a 401 refetches the token once and retries the call", async () => {
    const { client, counts, calls } = setup({
      [STATUS_PATH]: (c) => (c.headers.authorization === "Bearer tok-1" ? { status: 401, json: {} } : { json: completed }),
    });
    const s = await client.getTransactionStatus("trk-1");
    expect(s.statusCode).toBe(1);
    expect(counts[TOKEN_PATH]).toBe(2);
    expect(counts[STATUS_PATH]).toBe(2);
    expect(calls.filter((c) => c.path.includes("GetTransactionStatus")).map((c) => c.headers.authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  test("a persistent 401 gives up after exactly one retry", async () => {
    const { client, counts } = setup({ [STATUS_PATH]: () => ({ status: 401, json: {} }) });
    await expect(client.getTransactionStatus("trk-1")).rejects.toMatchObject({ kind: "auth" });
    expect(counts[STATUS_PATH]).toBe(2);
    expect(counts[TOKEN_PATH]).toBe(2);
  });

  test("an expired token reported with HTTP 200 + body status 401 is also retried", async () => {
    const { client, counts } = setup({
      [STATUS_PATH]: (c) => (c.headers.authorization === "Bearer tok-1" ? { json: { status: "401", error: { error_type: "unauthorized", code: "invalid_token", message: "expired" } } } : { json: completed }),
    });
    expect((await client.getTransactionStatus("trk-1")).statusCode).toBe(1);
    expect(counts[TOKEN_PATH]).toBe(2);
  });
});

describe("response handling fails closed", () => {
  test("RequestToken with HTTP 200 but an error body is an auth failure, not a token", async () => {
    const { client } = setup({
      [TOKEN_PATH]: () => ({ json: { token: null, expiryDate: null, error: { error_type: "invalid_request", code: "invalid_consumer_key_or_secret_provided", message: "bad" }, status: "500" } }),
      [STATUS_PATH]: () => ({ json: completed }),
    });
    await expect(client.getTransactionStatus("x")).rejects.toMatchObject({ name: "PesapalError", kind: "auth" });
  });

  test("a status response without status_code is rejected, never read as pending", async () => {
    const { client } = setup({ [STATUS_PATH]: () => ({ json: { error: { error_type: "x", code: "order_not_found", message: "nope" }, status: "500" } }) });
    await expect(client.getTransactionStatus("x")).rejects.toMatchObject({ kind: "shape" });
  });

  test("an out-of-range status_code is rejected", async () => {
    const { client } = setup({ [STATUS_PATH]: () => ({ json: { status_code: 7 } }) });
    await expect(client.getTransactionStatus("x")).rejects.toMatchObject({ kind: "shape" });
  });

  test("a sparse PENDING response (empty amount/method/code) is accepted", async () => {
    const { client } = setup({
      [STATUS_PATH]: () => ({ json: { payment_method: "", amount: 0, created_date: "", confirmation_code: "", payment_status_description: "Invalid", description: "", message: "Request processed successfully", payment_account: "", call_back_url: "https://x", status_code: 0, merchant_reference: "in_x", currency: "", error: { error_type: null, code: null, message: null, call_back_url: null }, status: "200" } }),
    });
    const s = await client.getTransactionStatus("x");
    expect(s).toMatchObject({ statusCode: 0, amount: 0, currency: null, confirmationCode: null, paymentMethod: null, merchantReference: "in_x" });
  });

  test("string status_code and string amount are normalised", async () => {
    const { client } = setup({ [STATUS_PATH]: () => ({ json: { ...completed, status_code: "1", amount: "19.00" } }) });
    expect(await client.getTransactionStatus("x")).toMatchObject({ statusCode: 1, amount: 19, currency: "USD" });
  });

  test("non-JSON bodies and HTTP errors surface as PesapalError", async () => {
    const a = setup({ [STATUS_PATH]: () => ({ text: "<html>gateway</html>" }) });
    await expect(a.client.getTransactionStatus("x")).rejects.toBeInstanceOf(PesapalError);
    const b = setup({ [STATUS_PATH]: () => ({ status: 503, json: {} }) });
    await expect(b.client.getTransactionStatus("x")).rejects.toMatchObject({ kind: "http", httpStatus: 503 });
  });

  test("network failures never leak the request", async () => {
    const client = createPesapalClient(CREDS, {
      fetch: async () => {
        throw new Error("ECONNRESET to https://x/?secret=abc");
      },
      cache: createTokenCache(),
    });
    const err = await client.getTransactionStatus("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PesapalError);
    expect((err as Error).message).not.toContain("secret");
  });
});

describe("submitOrder", () => {
  const ok = { order_tracking_id: "d0fa69d6-f3cd-433b-858e-df86555b86c8", merchant_reference: "in_abc", redirect_url: "https://cybqa.pesapal.com/pesapaliframe/PesapalIframe3/Index/?OrderTrackingId=d0fa69d6", error: null, status: "200", message: "Request processed successfully" };
  const input = { id: "in_abc", currency: "USD", amount: 19, description: "Reelcast Pro plan - 30 days", callbackUrl: "https://app.test/api/billing/callback", cancellationUrl: "https://app.test/billing?status=cancelled", notificationId: "ipn-guid", billing: { email: "a@b.co", firstName: "Ann" } };

  test("sends the documented fields and returns tracking id + redirect", async () => {
    const { client, calls } = setup({ "POST /pesapalv3/api/Transactions/SubmitOrderRequest": () => ({ json: ok }) });
    const r = await client.submitOrder(input);
    expect(r.orderTrackingId).toBe(ok.order_tracking_id);
    const body = calls.find((c) => c.path.endsWith("SubmitOrderRequest"))?.body as Record<string, unknown>;
    expect(body).toMatchObject({ id: "in_abc", currency: "USD", amount: 19, callback_url: input.callbackUrl, cancellation_url: input.cancellationUrl, notification_id: "ipn-guid", billing_address: { email_address: "a@b.co", first_name: "Ann" } });
  });

  test("rejects bad merchant references and amounts before any request", async () => {
    const { client, calls } = setup({});
    await expect(client.submitOrder({ ...input, id: "has space" })).rejects.toMatchObject({ kind: "validation" });
    await expect(client.submitOrder({ ...input, id: "x".repeat(51) })).rejects.toMatchObject({ kind: "validation" });
    await expect(client.submitOrder({ ...input, amount: 0 })).rejects.toMatchObject({ kind: "validation" });
    await expect(client.submitOrder({ ...input, billing: {} })).rejects.toMatchObject({ kind: "validation" });
    expect(calls.length).toBe(0);
  });

  test("rejects non-https redirects, echo mismatches and error bodies", async () => {
    const run = (json: unknown) => setup({ "POST /pesapalv3/api/Transactions/SubmitOrderRequest": () => ({ json }) }).client.submitOrder(input);
    await expect(run({ ...ok, redirect_url: "http://evil.test/pay" })).rejects.toMatchObject({ kind: "shape" });
    await expect(run({ ...ok, merchant_reference: "someone_else" })).rejects.toMatchObject({ kind: "shape" });
    await expect(run({ ...ok, order_tracking_id: null })).rejects.toMatchObject({ kind: "shape" });
    await expect(run({ order_tracking_id: null, redirect_url: null, error: { error_type: "invalid_request", code: "duplicate_merchant_reference", message: "dup" }, status: "500" })).rejects.toMatchObject({ kind: "api" });
  });
});

describe("other endpoints", () => {
  test("registerIpn and getIpnList", async () => {
    const { client, calls } = setup({
      "POST /pesapalv3/api/URLSetup/RegisterIPN": () => ({ json: { url: "https://app.test/ipn", created_date: "2024-01-01T00:00:00Z", ipn_id: "guid-1", error: null, status: "200" } }),
      "GET /pesapalv3/api/URLSetup/GetIpnList": () => ({ json: [{ url: "https://app.test/ipn", ipn_id: "guid-1", error: null, status: "200" }, { url: null, ipn_id: null }] }),
    });
    expect(await client.registerIpn("https://app.test/ipn", "GET")).toEqual({ ipnId: "guid-1", url: "https://app.test/ipn" });
    expect((calls.find((c) => c.path.endsWith("RegisterIPN"))?.body as Record<string, unknown>).ipn_notification_type).toBe("GET");
    expect(await client.getIpnList()).toEqual([{ ipnId: "guid-1", url: "https://app.test/ipn" }]);
  });

  test("refund accepts either documented success shape; cancelOrder reads status", async () => {
    const a = setup({ "POST /pesapalv3/api/Transactions/RefundRequest": () => ({ json: { status: "200", message: "Refund request received" } }) });
    expect(await a.client.refund({ confirmationCode: "C", amount: 10, username: "admin", remarks: "dup" })).toEqual({ accepted: true, message: "Refund request received" });
    const b = setup({ "POST /pesapalv3/api/Transactions/RefundRequest": () => ({ json: { error: 200, message: "ok" } }) });
    expect((await b.client.refund({ confirmationCode: "C", amount: 10, username: "admin", remarks: "dup" })).accepted).toBe(true);
    const c = setup({ "POST /pesapalv3/api/Transactions/CancelOrder": () => ({ json: { status: "500", message: "Cannot cancel" } }) });
    expect((await c.client.cancelOrder("x")).cancelled).toBe(false);
  });
});
