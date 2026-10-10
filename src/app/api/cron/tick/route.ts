import { handleTickRequest } from "@/server/jobs/cron";

// Hobby-plan ceiling; the tick stops starting new work at ~240s.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Called every minute by Supabase pg_cron + pg_net in production (see scripts/db-cron.ts),
 * or by anything that can send an HTTP request with the CRON_SECRET (any host, any scheduler).
 * The work is in handleTickRequest (src/server/jobs/cron.ts).
 */
const handle = (req: Request) => handleTickRequest(req);

export const GET = handle;
export const POST = handle;
