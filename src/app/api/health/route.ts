import { handleHealthRequest } from "@/server/lib/health";

// Never cached or prerendered: the answer is "right now". The check gives the database 5 s, so 10 s is ample.
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Public, for an external uptime pinger (HEAD is answered from this GET by Next). Body is `{"status": "ok" | "degraded" | "down"}`
 * (503 only for "down"); the details are returned only with the cron secret. The work is in handleHealthRequest
 * (src/server/lib/health.ts).
 */
export const GET = (req: Request) => handleHealthRequest(req);
