// Port of convex/queue.ts: the publish queue (ready + scheduled videos, manually ordered).
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { settings, videos } from "@/db/schema";
import { uuidSchema } from "@/server/lib/content/schemas";
import { mutation, query } from "../rpc/define";
import { notFound } from "../rpc/errors";

const QUEUE_LIMIT = 1000;
const MAX_ORDERS = 1000;

/** Ready + scheduled videos: publishOrder ascending (nulls last), then oldest first. */
export const list = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return [];
    const rows = await ctx.db
      .select({
        id: videos.id,
        title: videos.title,
        thumbnailUrl: videos.thumbnailUrl,
        status: videos.status,
        scheduledPublishAt: videos.scheduledPublishAt,
        publishOrder: videos.publishOrder,
        duration: videos.duration,
        privacyStatus: videos.privacyStatus,
        publishAs: videos.publishAs,
        rawFileSize: videos.rawFileSize,
        storageMissing: videos.storageMissing,
        storageCheckedAt: videos.storageCheckedAt,
      })
      .from(videos)
      .where(and(eq(videos.userId, ctx.userId), inArray(videos.status, ["ready", "scheduled"])))
      .orderBy(sql`${videos.publishOrder} asc nulls last`, asc(videos.createdAt))
      .limit(QUEUE_LIMIT);
    return rows.map((r) => ({ ...r, storageMissing: r.storageMissing ?? false }));
  },
});

export const setPublishOrder = mutation({
  input: z.object({ videoId: uuidSchema, publishOrder: z.number().int() }),
  handler: async (ctx, { videoId, publishOrder }) => {
    const rows = await ctx.db
      .update(videos)
      .set({ publishOrder, updatedAt: new Date() })
      .where(and(eq(videos.id, videoId), eq(videos.userId, ctx.userId)))
      .returning({ id: videos.id });
    if (!rows[0]) throw notFound("Video not found");
  },
});

/**
 * Reorder several videos in ONE statement. All-or-nothing: unless every id belongs to the caller,
 * nothing is updated and the call fails (Convex got this from its mutation transaction).
 */
export const bulkSetPublishOrder = mutation({
  input: z.object({
    orders: z.array(z.object({ videoId: uuidSchema, publishOrder: z.number().int() })).max(MAX_ORDERS),
  }),
  handler: async (ctx, { orders }) => {
    // Last write wins for repeated ids, like sequential patches would.
    const byId = new Map<string, number>();
    for (const o of orders) byId.set(o.videoId.toLowerCase(), o.publishOrder);
    if (byId.size === 0) return;

    const values = sql.join(
      [...byId.entries()].map(([id, po]) => sql`(${id}::uuid, ${po}::int)`),
      sql`, `,
    );
    const rows = (await ctx.db.execute(sql`
      with input(id, po) as (values ${values}),
      owned as (
        select count(*)::int as c from videos where user_id = ${ctx.userId} and id in (select id from input)
      )
      update videos v set publish_order = i.po, updated_at = now()
      from input i
      where v.id = i.id and v.user_id = ${ctx.userId} and (select c from owned) = ${byId.size}
      returning v.id
    `)) as unknown as { id: string }[];
    if (rows.length !== byId.size) throw notFound("Video not found");
  },
});

export const getQueueStats = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return { readyCount: 0, scheduledCount: 0, nextPublishAt: null };

    const counts = (await ctx.db.execute(sql`
      select status, count(*)::int as n
      from videos
      where user_id = ${ctx.userId} and status in ('ready', 'scheduled')
      group by status
    `)) as unknown as { status: string; n: number }[];
    const [s] = await ctx.db
      .select({ nextAt: settings.autoPublishNextAt })
      .from(settings)
      .where(eq(settings.userId, ctx.userId))
      .limit(1);

    const count = (status: string) => Number(counts.find((c) => c.status === status)?.n ?? 0);
    return { readyCount: count("ready"), scheduledCount: count("scheduled"), nextPublishAt: s?.nextAt ?? null };
  },
});
