"use client";

/**
 * Browser API. Mirrors `convex/react` so call sites port by swapping the import:
 *
 *   import { api, useQuery, useMutation, useAction } from "@/lib/rpc/client";
 *   const videos = useQuery(api.videos.list);            // undefined while loading
 *   const video  = useQuery(api.videos.get, id ? { id } : "skip");
 *   const update = useMutation(api.videos.updateStatus); // await update({ id, status })
 *
 * Writes (mutations AND actions) invalidate every cached query when they resolve, which
 * stands in for Convex's global reactivity. Queries listed in LIVE also poll while the tab
 * is visible (job/queue status, notifications).
 */
import { useQuery as useTanQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { ApiShape, ArgsOf, FnRef, RestArgs, ReturnOf } from "./types";

export type { Doc, Id } from "./types";

export class RpcClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcClientError";
    this.code = code;
  }
}

/** path -> poll interval (ms). Replaces Convex push for queries whose data changes server-side. */
export const LIVE: Record<string, number> = {
  "jobs.list": 4000,
  "generations.listByUser": 5000,
  "queue.list": 5000,
  "queue.getQueueStats": 5000,
  "videos.get": 4000,
  "videos.list": 10000,
  "videos.listScheduled": 15000,
  "notifications.get": 20000,
  "settings.get": 30000,
  "billing.getStatus": 10000,
  "admin.jobs.listRecent": 10000,
  "admin.jobs.listFailed": 15000,
  "admin.billing.overview": 30000,
  "admin.billing.listNeedsReview": 30000,
  "admin.stats.getStats": 30000,
  "admin.quota.getQuotaOverview": 30000,
};

export async function rpcCall(path: string, args: unknown): Promise<unknown> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ path, args: args ?? {} }),
  });
  let body: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  try {
    body = await res.json();
  } catch {
    throw new RpcClientError("INTERNAL", `Request failed (${res.status})`);
  }
  if (!body.ok) throw new RpcClientError(body.error?.code ?? "INTERNAL", body.error?.message ?? "Request failed");
  return body.data;
}

function makeRef(path: string[]): unknown {
  return new Proxy(
    { __path: path.join(".") },
    {
      get(target, prop) {
        if (prop === "__path") return target.__path;
        if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
        return makeRef([...path, prop]);
      },
    },
  );
}

/** `api.videos.list`, `api.admin.users.setPlan`, `api.actions.publishNow.publishNow`, ... */
export const api = makeRef([]) as ApiShape;

type AnyRef = FnRef<"query" | "mutation" | "action", never, unknown> | FnRef<"query" | "mutation" | "action", any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const isUnauthenticated = (e: unknown) => e instanceof RpcClientError && e.code === "UNAUTHENTICATED";

export function useQuery<F extends FnRef<"query", never, unknown> | FnRef<"query", any, any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
  ref: F,
  ...rest: RestArgs<F, true>
): ReturnOf<F> | undefined {
  const args = rest[0] as ArgsOf<F> | "skip" | undefined;
  const skip = args === "skip";
  const path = ref.__path;
  const { data } = useTanQuery({
    queryKey: ["rpc", path, skip ? null : (args ?? {})],
    queryFn: () => rpcCall(path, args ?? {}),
    enabled: !skip,
    refetchInterval: LIVE[path] ?? false,
    // Like Convex, surface unexpected errors to the nearest error boundary,
    // but treat "signed out" as "no data".
    throwOnError: (err) => !isUnauthenticated(err),
    retry: (count, err) => !isUnauthenticated(err) && count < 2,
  });
  return skip ? undefined : (data as ReturnOf<F> | undefined);
}

function useWrite<F extends AnyRef>(ref: F) {
  const qc = useQueryClient();
  const path = ref.__path;
  return useCallback(
    async (...rest: unknown[]) => {
      const result = await rpcCall(path, rest[0] ?? {});
      await qc.invalidateQueries({ queryKey: ["rpc"] });
      return result;
    },
    [qc, path],
  ) as (...rest: RestArgs<F>) => Promise<ReturnOf<F>>;
}

export function useMutation<F extends FnRef<"mutation", never, unknown> | FnRef<"mutation", any, any>>(ref: F) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return useWrite(ref);
}

export function useAction<F extends FnRef<"action", never, unknown> | FnRef<"action", any, any>>(ref: F) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return useWrite(ref);
}
