/**
 * The cron secret check, in a module of its own so a light route (`/api/health`) can use it without importing the
 * job runner (cron.ts imports tick.ts, which imports every job handler).
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Does the request carry `secret`, as `Authorization: Bearer <secret>` or an `x-cron-secret` header? Compared in
 * constant time. An unset or empty secret authorizes nothing, whatever the request says.
 */
export function hasCronSecret(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : (req.headers.get("x-cron-secret") ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Is this request from the scheduler? Checks against the `CRON_SECRET` of this process. */
export function authorized(req: Request): boolean {
  return hasCronSecret(req, process.env.CRON_SECRET);
}
