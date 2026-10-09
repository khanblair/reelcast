import { db } from "@/db/client";
import { handleIpn } from "@/server/billing/pesapal/ipn";
import { getProvider } from "@/server/billing/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Pesapal calls this with GET or POST depending on how the IPN URL was registered (we register GET).
// Authenticity comes from re-fetching the status from Pesapal, never from the request itself.
const handle = (req: Request) => handleIpn(req, { db, getProvider });

export const GET = handle;
export const POST = handle;
