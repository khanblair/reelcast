/**
 * Resolve "videos.list" / "admin.users.setPlan" against the registry, authenticate,
 * validate input with zod, run the handler, and convert the result to the wire format.
 * Used by the HTTP route and directly by tests.
 */
import { ZodError } from "zod";
import { db } from "@/db/client";
import { getSessionUser } from "@/server/auth";
import type { AuthLevel, PublicCtx, UserCtx, UserRow } from "./define";
import { RpcError, badRequest, forbidden, notFound, unauthenticated } from "./errors";
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

export async function dispatch({ registry, path, args, req, override }: DispatchOptions): Promise<unknown> {
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
    // Public functions may still want to know who is calling (e.g. users.current).
    const maybeUser = override && "user" in override ? user : await getSessionUser().catch(() => null);
    ctx = { db: database, req, user: maybeUser, userId: maybeUser?.id ?? null, isAdmin: maybeUser?.isAdmin ?? false };
  } else {
    if (!user) throw unauthenticated();
    if (def.auth === "admin" && !user.isAdmin) throw forbidden("Admin access required");
    ctx = { db: database, req, user, userId: user.id, isAdmin: user.isAdmin };
  }

  const result = await def.handler(ctx as never, parsed.data as never);
  return result === undefined ? null : toWire(result) ?? null;
}

export function toErrorBody(err: unknown): { status: number; body: { ok: false; error: { code: string; message: string } } } {
  if (err instanceof RpcError) {
    return { status: err.status, body: { ok: false, error: { code: err.code, message: err.message } } };
  }
  if (err instanceof ZodError) {
    return { status: 400, body: { ok: false, error: { code: "BAD_REQUEST", message: "Invalid arguments" } } };
  }
  console.error("[rpc] unhandled error", err);
  return { status: 500, body: { ok: false, error: { code: "INTERNAL", message: "Internal error" } } };
}
