import { NextResponse } from "next/server";
import { dispatch, toErrorBody } from "@/server/rpc/dispatch";
import { logRpcCall } from "@/server/rpc/log";
import { api } from "@/server/rpc/registry";
import { checkRpcHeaders, readJsonBody } from "@/server/rpc/request-guard";

// Hobby-plan ceiling. Anything that can run longer must be queued as a job instead.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Single entry point for all browser -> server calls: POST { path, args }.
 * Same-origin JSON only, at most 1 MiB (CSRF and resource defence for cookie auth; the rules live in request-guard.ts).
 */
export async function POST(req: Request) {
  const started = performance.now();
  // A request refused before it reaches dispatch() still gets its one log line (it never ran a statement or had a user).
  const refuse = (status: number, code: string, message: string, path = "") => {
    logRpcCall({ path, ok: false, code, ms: performance.now() - started, stmts: 0, uid: null });
    return NextResponse.json({ ok: false, error: { code, message } }, { status });
  };

  // Header-only checks first (cross-site, foreign Origin, content type, declared size), then the size-capped body read.
  const refused = checkRpcHeaders(req);
  if (refused) return refuse(refused.status, refused.code, refused.message);

  const body = await readJsonBody(req);
  if (!body.ok) return refuse(body.refusal.status, body.refusal.code, body.refusal.message);
  const payload = body.value as { path?: unknown; args?: unknown } | null;
  if (typeof payload?.path !== "string") {
    return refuse(400, "BAD_REQUEST", "Missing path");
  }

  try {
    const data = await dispatch({ registry: api, path: payload.path, args: payload.args, req });
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const { status, body } = toErrorBody(err);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }
}
