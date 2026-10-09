/**
 * RPC function definitions. A module under src/server/modules/ exports these; the
 * registry (registry.ts) lists the modules the browser may call. Anything NOT exported
 * through the registry is internal (the equivalent of Convex `internal.*`).
 *
 *   export const list = query({
 *     input: z.object({ status: z.enum(VIDEO_STATUSES).optional() }),
 *     handler: async (ctx, args) => ctx.db.select()...   // ctx.userId is trusted
 *   });
 *
 * Auth levels:
 *   "user"   (default) signed-in user; ctx.userId / ctx.user populated
 *   "admin"  signed-in user whose users.is_admin = true (read from the DB, never the token)
 *   "public" no session required; ctx.userId is null
 */
import { z } from "zod";
import type { DbLike } from "@/db/client";
import type { users } from "@/db/schema";

export type UserRow = typeof users.$inferSelect;

export type UserCtx = {
  db: DbLike;
  userId: string;
  user: UserRow;
  isAdmin: boolean;
  req: Request;
};
export type PublicCtx = {
  db: DbLike;
  userId: string | null;
  user: UserRow | null;
  isAdmin: boolean;
  req: Request;
};

export type AuthLevel = "user" | "admin" | "public";
export type FnKind = "query" | "mutation" | "action";

export type FnDef<K extends FnKind, A, R, L extends AuthLevel> = {
  readonly __rpc: true;
  readonly kind: K;
  readonly auth: L;
  readonly input: z.ZodType<A, z.ZodTypeDef, unknown>;
  readonly handler: (ctx: L extends "public" ? PublicCtx : UserCtx, args: A) => Promise<R>;
  /** Phantom types for inference on the client. */
  readonly _types: { args: A; ret: R };
};

type Opts<S extends z.ZodTypeAny | undefined, R, L extends AuthLevel> = {
  auth?: L;
  input?: S;
  handler: (
    ctx: L extends "public" ? PublicCtx : UserCtx,
    args: S extends z.ZodTypeAny ? z.infer<S> : Record<string, never>,
  ) => Promise<R>;
};

function make<K extends FnKind>(kind: K) {
  return function define<
    R,
    S extends z.ZodTypeAny | undefined = undefined,
    L extends AuthLevel = "user",
  >(opts: Opts<S, R, L>): FnDef<K, S extends z.ZodTypeAny ? z.infer<S> : Record<string, never>, R, L> {
    return {
      __rpc: true,
      kind,
      auth: (opts.auth ?? "user") as L,
      input: (opts.input ?? z.object({}).strict()) as never,
      handler: opts.handler as never,
      _types: undefined as never,
    };
  };
}

/** Read-only; the browser may poll/refetch it freely. */
export const query = make("query");
/** Writes; the browser invalidates cached queries after it succeeds. */
export const mutation = make("mutation");
/** Side-effecting / external I/O (Gemini, YouTube, ...). Keep under ~30s; longer work must become a job. */
export const action = make("action");

export type AnyFnDef = FnDef<FnKind, never, unknown, AuthLevel> | FnDef<FnKind, any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
