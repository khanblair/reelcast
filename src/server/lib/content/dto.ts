/**
 * Column projections returned to the browser. Videos hold no secrets, so rows leave as-is
 * (the RPC layer converts them to the wire shape); these projections only trim payload size
 * and hide queue internals (lock/attempt/metadata columns on jobs).
 */
import { getTableColumns } from "drizzle-orm";
import { jobs, videos } from "@/db/schema";

const allVideoColumns = getTableColumns(videos);

/**
 * List views never show the caption transcript (it can be tens of KB per video and these lists
 * are polled); only `videos.get` returns it.
 */
export const videoListColumns = Object.fromEntries(
  Object.entries(allVideoColumns).filter(([key]) => key !== "captionsVtt"),
) as Omit<typeof allVideoColumns, "captionsVtt">;

export const videoColumns = allVideoColumns;

/** The Job document the UI was written against (no attempts/lock/metadata). */
export const jobColumns = {
  id: jobs.id,
  userId: jobs.userId,
  videoId: jobs.videoId,
  type: jobs.type,
  status: jobs.status,
  error: jobs.error,
  startedAt: jobs.startedAt,
  completedAt: jobs.completedAt,
  createdAt: jobs.createdAt,
} as const;

/** Hard cap for lists the UI used to receive unbounded (newest first). */
export const LIST_LIMIT = 500;
