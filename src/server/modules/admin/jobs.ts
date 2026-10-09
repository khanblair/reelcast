// Port of convex/admin/jobs.ts. Admin-only; results are explicit column projections.
import { desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { jobs, users, videos } from "@/db/schema";
import type { DbLike } from "@/db/client";
import { query } from "../../rpc/define";

const input = z.object({ limit: z.number().int().min(1).max(200).optional() });

async function listJobs(db: DbLike, limit: number, where?: SQL) {
  const rows = await db
    .select({
      id: jobs.id,
      createdAt: jobs.createdAt,
      type: jobs.type,
      status: jobs.status,
      error: jobs.error,
      startedAt: jobs.startedAt,
      completedAt: jobs.completedAt,
      userEmail: users.email,
      videoTitle: videos.title,
    })
    .from(jobs)
    .leftJoin(users, eq(users.id, jobs.userId))
    .leftJoin(videos, eq(videos.id, jobs.videoId))
    .where(where)
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, userEmail: r.userEmail ?? "unknown", videoTitle: r.videoTitle ?? "(deleted)" }));
}

/** Failed jobs across all users, newest first. */
export const listFailed = query({
  auth: "admin",
  input,
  handler: (ctx, args) => listJobs(ctx.db, args.limit ?? 50, eq(jobs.status, "failed")),
});

/** Most recent jobs across all users regardless of status. */
export const listRecent = query({
  auth: "admin",
  input,
  handler: (ctx, args) => listJobs(ctx.db, args.limit ?? 50),
});
