/**
 * Resolve "videos.list" / "admin.users.setPlan" against the registry, authenticate,
 * validate input with zod, run the handler, and convert the result to the wire format.
 * Used by the HTTP route and directly by tests.
 *
 * Every call also emits exactly one structured log line (./log.ts) with its path, outcome, duration, SQL statement
 * count and user id, and reports INTERNAL / unexpected failures to the pluggable error reporter.
 */
import { ZodError } from "zod";
import { db } from "@/db/client";
import { withQueryCount } from "@/db/query-counter";
import { getSessionUser } from "@/server/auth";
import { reportError } from "@/server/lib/error-reporter";
import type { AuthLevel, PublicCtx, UserCtx, UserRow } from "./define";
import { RpcError, badRequest, forbidden, notFound, unauthenticated, type RpcErrorCode } from "./errors";
import { logRpcAuthError, logRpcCall } from "./log";
import { toWire } from "./wire";

type AnyDef = {
  __rpc: true;
  kind: string;
  auth: AuthLevel;
  input: { safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: ZodError } };
  handler: (ctx: never, args: never) => Promise<unknown>;
};

function isDef(v: unknown): v is AnyDef {
  return typeof v === "object" && v !== null && (v as { __rpc?: unknown }).__rpc === true;
}

export function resolveDef(registry: object, path: string): AnyDef {
  let node: unknown = registry;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) throw notFound(`Unknown function: ${path}`);
    node = (node as Record<string, unknown>)[part];
  }
  if (!isDef(node)) throw notFound(`Unknown function: ${path}`);
  return node;
}

export type DispatchOptions = {
  registry: object;
  path: string;
  args: unknown;
  req: Request;
  /** Tests inject a user (and optionally a transaction as `db`) instead of reading the session. */
  override?: { user?: UserRow | null; db?: UserCtx["db"] };
};

/** What the log line needs to know about a call, filled in as the call learns it. */
type CallMeta = { uid: string | null };

async function runCall({ registry, path, args, req, override }: DispatchOptions, meta: CallMeta): Promise<unknown> {
  const def = resolveDef(registry, path);

  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(`Invalid arguments${issue ? `: ${issue.path.join(".") || "(root)"} ${issue.message}` : ""}`);
  }

  const user = override && "user" in override ? (override.user ?? null) : def.auth === "public" ? null : await getSessionUser();
  const database = override?.db ?? db;

  let ctx: UserCtx | PublicCtx;
  if (def.auth === "public") {
    // Public functions may still want to know who is calling (e.g. users.current). A failed lookup keeps the call
    // anonymous, but it is logged: swallowing it silently hid auth and database outages.
    const maybeUser = override && "user" in override ? user : await getSessionUser().catch((err) => (logRpcAuthError(path, err), null));
    meta.uid = maybeUser?.id ?? null;
    ctx = { db: database, req, user: maybeUser, userId: maybeUser?.id ?? null, isAdmin: maybeUser?.isAdmin ?? false };
  } else {
    if (!user) throw unauthenticated();
    meta.uid = user.id;
    if (def.auth === "admin" && !user.isAdmin) throw forbidden("Admin access required");
    ctx = { db: database, req, user, userId: user.id, isAdmin: user.isAdmin };
  }

  const result = await def.handler(ctx as never, parsed.data as never);
  return result === undefined ? null : toWire(result) ?? null;
}

export async function dispatch(options: DispatchOptions): Promise<unknown> {
  const started = performance.now();
  const meta: CallMeta = { uid: null };
  return withQueryCount(async (statements) => {
    try {
      const result = await runCall(options, meta);
      logRpcCall({ path: options.path, ok: true, code: null, ms: performance.now() - started, stmts: statements(), uid: meta.uid });
      return result;
    } catch (err) {
      const { code } = classifyError(err);
      logRpcCall({ path: options.path, ok: false, code, ms: performance.now() - started, stmts: statements(), uid: meta.uid });
      if (code === "INTERNAL") reportError({ path: options.path, code, message: reportMessage(err), uid: meta.uid });
      throw err;
    }
  });
}

/** The wire code and HTTP status of a thrown value. The log line and the HTTP response both use it, so they always agree. */
export function classifyError(err: unknown): { code: RpcErrorCode; status: number; message: string } {
  if (err instanceof RpcError) return { code: err.code, status: err.status, message: err.message };
  if (err instanceof ZodError) return { code: "BAD_REQUEST", status: 400, message: "Invalid arguments" };
  return { code: "INTERNAL", status: 500, message: "Internal error" };
}

const firstLine = (s: string) => s.split("\n", 1)[0].slice(0, 300);

/**
 * The message handed to the error reporter. Drizzle wraps a failed statement as "Failed query: <sql> params: <values>",
 * and the values are user data (emails, ids), so for those only the underlying database message is used.
 */
function reportMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Non-error value thrown";
  if (err instanceof RpcError) return firstLine(err.message);
  if (err.message.startsWith("Failed query:")) return firstLine(err.cause instanceof Error ? err.cause.message : "Failed query");
  return firstLine(err.message);
}

export function toErrorBody(err: unknown): { status: number; body: { ok: false; error: { code: string; message: string } } } {
  const { code, status, message } = classifyError(err);
  if (code === "INTERNAL" && !(err instanceof RpcError)) console.error("[rpc] unhandled error", err);
  return { status, body: { ok: false, error: { code, message } } };
}
