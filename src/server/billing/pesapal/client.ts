/**
 * Pesapal API 3.0 (JSON) client. Raw fetch, no SDK. Server-only.
 *
 * Docs: https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/api-reference
 *
 * Design rules
 *  - Every response is parsed with zod and the client FAILS CLOSED on a shape it does not understand.
 *    The one deliberate leniency: Pesapal returns sparse bodies for unpaid orders (empty amount /
 *    method / code), so only `status_code` is mandatory on GetTransactionStatus.
 *  - Pesapal answers some failures with HTTP 200 and a populated `error` object, so success is judged
 *    from the BODY, not from `res.ok` alone.
 *  - The bearer token (valid ~5 minutes) is cached per (environment, credentials), refreshed 30s
 *    before expiry, shared between concurrent callers, and re-fetched once after a 401.
 *  - Secrets are never logged or put into error messages.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export type PesapalEnvironment = "sandbox" | "live";

export const PESAPAL_BASE_URL: Record<PesapalEnvironment, string> = {
  sandbox: "https://cybqa.pesapal.com/pesapalv3",
  live: "https://pay.pesapal.com/v3",
};

export type PesapalCredentials = {
  consumerKey: string;
  consumerSecret: string;
  environment: PesapalEnvironment;
};

export class PesapalError extends Error {
  readonly kind: "validation" | "network" | "auth" | "http" | "api" | "shape";
  readonly httpStatus: number | null;
  constructor(kind: PesapalError["kind"], message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "PesapalError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

// ─── response schemas ────────────────────────────────────────────────────────

const looseString = z.union([z.string(), z.number()]).nullish();
const errorField = z.union([z.null(), z.string(), z.number(), z.record(z.unknown())]).optional();

/** Pesapal's `error` is null on success; on failure it is an object ({error_type, code, message}). */
function errorMessage(err: unknown): string | null {
  if (err === null || err === undefined || err === "") return null;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const parts = [o.error_type, o.code, o.message].filter((v) => v !== null && v !== undefined && v !== "");
    return parts.length ? parts.map(String).join(" ").slice(0, 200) : null;
  }
  return String(err).slice(0, 200);
}

const tokenSchema = z.object({
  token: z.string().nullish(),
  expiryDate: z.string().nullish(),
  error: errorField,
  status: looseString,
  message: z.string().nullish(),
});

const ipnSchema = z.object({
  url: z.string().nullish(),
  ipn_id: z.string().nullish(),
  created_date: z.string().nullish(),
  error: errorField,
  status: looseString,
  message: z.string().nullish(),
});
const ipnListSchema = z.array(ipnSchema);

const submitOrderSchema = z.object({
  order_tracking_id: z.string().nullish(),
  merchant_reference: z.string().nullish(),
  redirect_url: z.string().nullish(),
  error: errorField,
  status: looseString,
  message: z.string().nullish(),
});

const numish = z.preprocess((v) => {
  if (typeof v === "string") return v.trim() === "" ? null : Number(v);
  return v;
}, z.number().finite().nullable());

const statusCodeSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().int().min(0).max(3),
);

const transactionStatusSchema = z.object({
  status_code: statusCodeSchema,
  payment_status_description: z.string().nullish(),
  merchant_reference: z.string().nullish(),
  amount: numish.optional(),
  currency: z.string().nullish(),
  confirmation_code: z.string().nullish(),
  payment_method: z.string().nullish(),
  payment_account: z.string().nullish(),
  created_date: z.string().nullish(),
});

const simpleResultSchema = z.object({
  status: looseString,
  error: errorField,
  message: z.string().nullish(),
});

// ─── public types ────────────────────────────────────────────────────────────

export type PesapalTransactionStatus = {
  /** 0 invalid/pending, 1 completed, 2 failed, 3 reversed */
  statusCode: 0 | 1 | 2 | 3;
  statusDescription: string | null;
  merchantReference: string | null;
  amount: number | null;
  currency: string | null;
  confirmationCode: string | null;
  paymentMethod: string | null;
  paymentAccount: string | null;
  createdDate: string | null;
};

export type SubmitOrderInput = {
  /** Our unique merchant reference (<= 50 chars, [A-Za-z0-9-_.:], unique forever). */
  id: string;
  currency: string;
  amount: number;
  description: string;
  callbackUrl: string;
  cancellationUrl?: string;
  /** ipn_id returned by RegisterIPN. */
  notificationId: string;
  billing: { email?: string; phone?: string; firstName?: string; lastName?: string };
};

export type PesapalClient = {
  registerIpn(url: string, type: "GET" | "POST"): Promise<{ ipnId: string; url: string }>;
  getIpnList(): Promise<{ ipnId: string; url: string }[]>;
  submitOrder(input: SubmitOrderInput): Promise<{ orderTrackingId: string; merchantReference: string | null; redirectUrl: string }>;
  getTransactionStatus(orderTrackingId: string): Promise<PesapalTransactionStatus>;
  /** HTTP method undocumented by Pesapal; POST assumed (the request carries a JSON body). */
  refund(input: { confirmationCode: string; amount: number; username: string; remarks: string }): Promise<{ accepted: boolean; message: string }>;
  /** HTTP method undocumented by Pesapal; POST assumed. Only failed/pending orders can be cancelled. */
  cancelOrder(orderTrackingId: string): Promise<{ cancelled: boolean; message: string }>;
};

// ─── token cache ─────────────────────────────────────────────────────────────

type TokenEntry = { token: string; expiresAt: number };
export type TokenCache = { tokens: Map<string, TokenEntry>; inflight: Map<string, Promise<string>> };

export function createTokenCache(): TokenCache {
  return { tokens: new Map(), inflight: new Map() };
}
const defaultTokenCache = createTokenCache();

export const TOKEN_REFRESH_SKEW_MS = 30_000;
/** Pesapal tokens live for at most 5 minutes. */
export const TOKEN_MAX_TTL_MS = 5 * 60_000;
const TOKEN_FALLBACK_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/** "2021-08-26T12:29:30.5177702Z" (7 fractional digits) is not parsed identically by every JS engine. */
export function parsePesapalDate(raw: string | null | undefined): number {
  if (!raw) return NaN;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim());
  if (!m) return NaN;
  const frac = m[2] ? `.${m[2].slice(1, 4).padEnd(3, "0")}` : "";
  return Date.parse(`${m[1]}${frac}${m[3] ?? "Z"}`);
}

function cacheKey(creds: PesapalCredentials): string {
  const digest = createHash("sha256").update(`${creds.consumerKey}\u0000${creds.consumerSecret}`).digest("hex");
  return `${creds.environment}:${digest}`;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PesapalClientOptions = {
  fetch?: FetchLike;
  now?: () => number;
  cache?: TokenCache;
  timeoutMs?: number;
};

const ID_RE = /^[A-Za-z0-9\-_.:]{1,50}$/;

function looksLikeAuthFailure(httpStatus: number, body: unknown): boolean {
  if (httpStatus === 401) return true;
  if (body && typeof body === "object") {
    const o = body as { status?: unknown; error?: unknown };
    if (String(o.status ?? "") === "401") return true;
    const msg = errorMessage(o.error)?.toLowerCase() ?? "";
    if (msg.includes("invalid_token") || msg.includes("unauthorized") || msg.includes("unauthorised")) return true;
  }
  return false;
}

export function createPesapalClient(creds: PesapalCredentials, opts: PesapalClientOptions = {}): PesapalClient {
  const base = PESAPAL_BASE_URL[creds.environment];
  const now = opts.now ?? (() => Date.now());
  const cache = opts.cache ?? defaultTokenCache;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = cacheKey(creds);
  // Resolve lazily so tests that swap globalThis.fetch after construction are honoured.
  const doFetch: FetchLike = (input, init) => (opts.fetch ?? globalThis.fetch)(input, init);

  async function rawRequest(method: "GET" | "POST", path: string, body: unknown, token: string | null): Promise<{ httpStatus: number; json: unknown }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      throw new PesapalError("network", e instanceof Error && e.name === "TimeoutError" ? "Pesapal request timed out" : "Pesapal request failed");
    }
    const text = await res.text();
    let json: unknown = null;
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { httpStatus: res.status, json };
  }

  async function fetchToken(): Promise<string> {
    const { httpStatus, json } = await rawRequest("POST", "/api/Auth/RequestToken", { consumer_key: creds.consumerKey, consumer_secret: creds.consumerSecret }, null);
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new PesapalError("auth", `Pesapal rejected the credentials (HTTP ${httpStatus})`, httpStatus);
    }
    const parsed = tokenSchema.safeParse(json);
    if (!parsed.success) throw new PesapalError("shape", "Unexpected RequestToken response");
    const err = errorMessage(parsed.data.error);
    if (err) throw new PesapalError("auth", `Pesapal rejected the credentials: ${err}`);
    if (!parsed.data.token) throw new PesapalError("auth", "Pesapal returned no token");
    const fetchedAt = now();
    let expiresAt = parsePesapalDate(parsed.data.expiryDate);
    if (!Number.isFinite(expiresAt) || expiresAt <= fetchedAt) expiresAt = fetchedAt + TOKEN_FALLBACK_TTL_MS;
    expiresAt = Math.min(expiresAt, fetchedAt + TOKEN_MAX_TTL_MS);
    cache.tokens.set(key, { token: parsed.data.token, expiresAt });
    return parsed.data.token;
  }

  async function getToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh) {
      const hit = cache.tokens.get(key);
      if (hit && hit.expiresAt - TOKEN_REFRESH_SKEW_MS > now()) return hit.token;
    } else {
      cache.tokens.delete(key);
    }
    const pending = cache.inflight.get(key);
    if (pending) return pending;
    const p = fetchToken().finally(() => cache.inflight.delete(key));
    cache.inflight.set(key, p);
    return p;
  }

  /** Authenticated call: one transparent retry with a fresh token after a 401. */
  async function call<S extends z.ZodTypeAny>(method: "GET" | "POST", path: string, body: unknown, schema: S): Promise<{ data: z.infer<S>; raw: unknown }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getToken(attempt > 0);
      const { httpStatus, json } = await rawRequest(method, path, body, token);
      if (attempt === 0 && looksLikeAuthFailure(httpStatus, json)) continue;
      if (httpStatus === 401) throw new PesapalError("auth", "Pesapal rejected the access token", 401);
      if (httpStatus < 200 || httpStatus >= 300) {
        const detail = json && typeof json === "object" ? errorMessage((json as { error?: unknown }).error) : null;
        throw new PesapalError("http", `Pesapal HTTP ${httpStatus}${detail ? `: ${detail}` : ""}`, httpStatus);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new PesapalError("shape", `Unexpected response from ${path}`);
      return { data: parsed.data as z.infer<S>, raw: json };
    }
    throw new PesapalError("auth", "Pesapal rejected the access token", 401);
  }

  return {
    async registerIpn(url, type) {
      const { data } = await call("POST", "/api/URLSetup/RegisterIPN", { url, ipn_notification_type: type }, ipnSchema);
      const err = errorMessage(data.error);
      if (err) throw new PesapalError("api", `RegisterIPN failed: ${err}`);
      if (!data.ipn_id) throw new PesapalError("shape", "RegisterIPN returned no ipn_id");
      return { ipnId: data.ipn_id, url: data.url ?? url };
    },

    async getIpnList() {
      const { data } = await call("GET", "/api/URLSetup/GetIpnList", undefined, ipnListSchema);
      return data.flatMap((i) => (i.ipn_id && i.url ? [{ ipnId: i.ipn_id, url: i.url }] : []));
    },

    async submitOrder(input) {
      if (!ID_RE.test(input.id)) throw new PesapalError("validation", "Invalid merchant reference");
      if (!Number.isFinite(input.amount) || input.amount <= 0) throw new PesapalError("validation", "Invalid amount");
      if (!input.billing.email && !input.billing.phone) throw new PesapalError("validation", "A billing email or phone is required");
      const { data } = await call(
        "POST",
        "/api/Transactions/SubmitOrderRequest",
        {
          id: input.id,
          currency: input.currency,
          amount: input.amount,
          description: input.description.slice(0, 100),
          callback_url: input.callbackUrl,
          ...(input.cancellationUrl ? { cancellation_url: input.cancellationUrl } : {}),
          redirect_mode: "TOP_WINDOW",
          notification_id: input.notificationId,
          billing_address: {
            ...(input.billing.email ? { email_address: input.billing.email } : {}),
            ...(input.billing.phone ? { phone_number: input.billing.phone } : {}),
            ...(input.billing.firstName ? { first_name: input.billing.firstName } : {}),
            ...(input.billing.lastName ? { last_name: input.billing.lastName } : {}),
          },
        },
        submitOrderSchema,
      );
      const err = errorMessage(data.error);
      if (err) throw new PesapalError("api", `SubmitOrderRequest failed: ${err}`);
      if (!data.order_tracking_id || !data.redirect_url) throw new PesapalError("shape", "SubmitOrderRequest returned no tracking id or redirect url");
      if (data.merchant_reference && data.merchant_reference !== input.id) throw new PesapalError("shape", "SubmitOrderRequest echoed a different merchant reference");
      let redirect: URL;
      try {
        redirect = new URL(data.redirect_url);
      } catch {
        throw new PesapalError("shape", "SubmitOrderRequest returned an invalid redirect url");
      }
      if (redirect.protocol !== "https:") throw new PesapalError("shape", "SubmitOrderRequest returned a non-https redirect url");
      return { orderTrackingId: data.order_tracking_id, merchantReference: data.merchant_reference ?? null, redirectUrl: redirect.toString() };
    },

    async getTransactionStatus(orderTrackingId) {
      const { data } = await call("GET", `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`, undefined, transactionStatusSchema);
      return {
        statusCode: data.status_code as 0 | 1 | 2 | 3,
        statusDescription: data.payment_status_description ?? null,
        merchantReference: data.merchant_reference || null,
        amount: data.amount ?? null,
        currency: data.currency || null,
        confirmationCode: data.confirmation_code || null,
        paymentMethod: data.payment_method || null,
        paymentAccount: data.payment_account || null,
        createdDate: data.created_date || null,
      };
    },

    async refund(input) {
      const { data } = await call(
        "POST",
        "/api/Transactions/RefundRequest",
        { confirmation_code: input.confirmationCode, amount: input.amount.toFixed(2), username: input.username, remarks: input.remarks },
        simpleResultSchema,
      );
      // The docs are inconsistent: the table says `error` (200 = received) but the sample uses `status`.
      const ok = String(data.status ?? "") === "200" || String(typeof data.error === "number" ? data.error : "") === "200";
      return { accepted: ok, message: data.message ?? "" };
    },

    async cancelOrder(orderTrackingId) {
      const { data } = await call("POST", "/api/Transactions/CancelOrder", { order_tracking_id: orderTrackingId }, simpleResultSchema);
      return { cancelled: String(data.status ?? "") === "200", message: data.message ?? "" };
    },
  };
}
