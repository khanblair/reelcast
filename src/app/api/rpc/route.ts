import { NextResponse } from "next/server";
import { dispatch, toErrorBody } from "@/server/rpc/dispatch";
import { logRpcCall } from "@/server/rpc/log";
import { api } from "@/server/rpc/registry";

// Hobby-plan ceiling. Anything that can run longer must be queued as a job instead.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Single entry point for all browser -> server calls: POST { path, args }.
 * Same-origin JSON only (CSRF defence for cookie auth).
 */
export async function POST(req: Request) {
  const started = performance.now();
  // A request refused before it reaches dispatch() still gets its one log line (it never ran a statement or had a user).
  const refuse = (status: number, code: string, message: string, path = "") => {
    logRpcCall({ path, ok: false, code, ms: performance.now() - started, stmts: 0, uid: null });
    return NextResponse.json({ ok: false, error: { code, message } }, { status });
  };

  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return refuse(403, "FORBIDDEN", "Cross-site request blocked");
  }
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return refuse(400, "BAD_REQUEST", "Expected application/json");
  }

  let payload: { path?: unknown; args?: unknown } | null;
  try {
    payload = await req.json();
  } catch {
    return refuse(400, "BAD_REQUEST", "Invalid JSON");
  }
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
