import { NextResponse } from "next/server";
import { dispatch, toErrorBody } from "@/server/rpc/dispatch";
import { api } from "@/server/rpc/registry";

// Hobby-plan ceiling. Anything that can run longer must be queued as a job instead.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Single entry point for all browser -> server calls: POST { path, args }.
 * Same-origin JSON only (CSRF defence for cookie auth).
 */
export async function POST(req: Request) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return NextResponse.json({ ok: false, error: { code: "FORBIDDEN", message: "Cross-site request blocked" } }, { status: 403 });
  }
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Expected application/json" } }, { status: 400 });
  }

  let payload: { path?: unknown; args?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid JSON" } }, { status: 400 });
  }
  if (typeof payload.path !== "string") {
    return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Missing path" } }, { status: 400 });
  }

  try {
    const data = await dispatch({ registry: api, path: payload.path, args: payload.args, req });
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const { status, body } = toErrorBody(err);
    return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  }
}
