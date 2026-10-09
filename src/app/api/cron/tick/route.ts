import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runTick } from "@/server/jobs/tick";

// Hobby-plan ceiling; the tick stops starting new work at ~240s.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : (req.headers.get("x-cron-secret") ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Called every minute by Supabase pg_cron + pg_net in production (see scripts/db-cron.ts),
 * or by anything that can send an HTTP request with the CRON_SECRET (any host, any scheduler).
 */
async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false }, { status: 401 });
  const budget = Number(new URL(req.url).searchParams.get("budgetMs"));
  const result = await runTick({ budgetMs: Number.isFinite(budget) && budget > 0 ? Math.min(budget, 270_000) : 240_000 });
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;
