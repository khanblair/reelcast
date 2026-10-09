import { db } from "@/db/client";
import { handleCallback } from "@/server/billing/pesapal/callback";
import { getProvider } from "@/server/billing/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Pesapal redirects the customer's browser here after the payment page.
export async function GET(req: Request) {
  return handleCallback(req, { db, getProvider });
}
