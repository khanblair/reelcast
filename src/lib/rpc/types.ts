/**
 * Client-side types for the RPC API. Type-only imports from the server registry are
 * erased at build time, so no server code reaches the browser bundle.
 */
import type { InferSelectModel } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type * as schema from "@/db/schema";
import type { Api } from "@/server/rpc/registry";
import type { Wire } from "@/server/rpc/wire";

type FnKind = "query" | "mutation" | "action";

export type FnRef<K extends FnKind, A, R> = {
  readonly __path: string;
  readonly _kind?: K;
  readonly _args?: A;
  readonly _ret?: R;
};

type Leaf<T> = T extends { __rpc: true; kind: infer K; _types: { args: infer A; ret: infer R } }
  ? K extends FnKind
    ? FnRef<K, A, Wire<R>>
    : never
  : T extends object
    ? ApiRefs<T>
    : never;

export type ApiRefs<T> = { readonly [K in keyof T]: Leaf<T[K]> };
export type ApiShape = ApiRefs<Api>;

export type ArgsOf<F> = F extends FnRef<FnKind, infer A, unknown> ? A : never;
export type ReturnOf<F> = F extends FnRef<FnKind, unknown, infer R> ? R : never;
export type RestArgs<F, Skippable extends boolean = false> = Record<string, never> extends ArgsOf<F>
  ? [args?: ArgsOf<F> | (Skippable extends true ? "skip" : never)]
  : [args: ArgsOf<F> | (Skippable extends true ? "skip" : never)];

/** Row type for a table in the wire format the UI sees (`_id`, `_creationTime`, optional fields). */
type Tables = {
  [K in keyof typeof schema as (typeof schema)[K] extends PgTable ? K : never]: (typeof schema)[K];
};
export type TableName = keyof Tables;
export type Doc<T extends TableName> = Wire<InferSelectModel<Tables[T]>>;
/** Ids are plain uuid strings. The table parameter is kept so call sites read like before. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type Id<_T extends string = string> = string;
