// Port of convex/admin/notifications.ts. Admin-only; broadcasts are batched and bounded.
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { NOTIFICATION_TYPES, notifications, users } from "@/db/schema";
import { notFound } from "../../rpc/errors";
import { mutation } from "../../rpc/define";

const BATCH = 1_000;
/** Hard ceiling per broadcast (50k recipients). A single click can never run unbounded. */
const MAX_BATCHES = 50;

// A notification link is rendered as an href: allow in-app paths and http(s) only
// (blocks javascript: / data: URLs).
const link = z
  .string()
  .max(500)
  .refine((v) => (v.startsWith("/") && !v.startsWith("//")) || /^https?:\/\//i.test(v), "Invalid link")
  .optional();

const content = {
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(2000),
  type: z.enum(NOTIFICATION_TYPES),
  link,
};

/** Send a notification to every user, in keyset-paginated INSERT..SELECT batches. */
export const broadcastToAll = mutation({
  auth: "admin",
  input: z.object(content),
  handler: async (ctx, args) => {
    let sent = 0;
    let after: string | null = null;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const rows = (await ctx.db.execute(sql`
        with batch as (
          select id from users
          where (${after}::uuid is null or id > ${after}::uuid)
          order by id
          limit ${BATCH}
        ), ins as (
          insert into notifications (user_id, title, message, type, link)
          select id, ${args.title}, ${args.message}, ${args.type}, ${args.link ?? null} from batch
          returning 1
        )
        select (select count(*) from ins)::int as inserted, (select id from batch order by id desc limit 1)::text as last_id
      `)) as unknown as { inserted: number; last_id: string | null }[];
      const { inserted, last_id } = rows[0] ?? { inserted: 0, last_id: null };
      sent += Number(inserted);
      if (!last_id || Number(inserted) < BATCH) break;
      after = last_id;
    }
    // `count` is what the UI reads; `sent` is the original Convex field.
    return { sent, count: sent };
  },
});

/** Send a notification to one specific user. */
export const sendToUser = mutation({
  auth: "admin",
  input: z.object({ userId: z.string().uuid(), ...content }),
  handler: async (ctx, args) => {
    const [target] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.id, args.userId)).limit(1);
    if (!target) throw notFound("User not found");
    await ctx.db.insert(notifications).values({
      userId: args.userId,
      title: args.title,
      message: args.message,
      type: args.type,
      link: args.link ?? null,
    });
  },
});
