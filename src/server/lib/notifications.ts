/**
 * In-app notifications (the bell in the top bar). Contract owned by agent B:
 *   createNotification(db, { userId, title, message, type, link? }): Promise<void>
 * Plain TS function (never an rpc export) so only server code can create notifications.
 */
import type { DbLike } from "@/db/client";
import { notifications, type NOTIFICATION_TYPES } from "@/db/schema";

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NewNotification = {
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  link?: string;
};

export async function createNotification(db: DbLike, n: NewNotification): Promise<void> {
  await db.insert(notifications).values({
    userId: n.userId,
    title: n.title,
    message: n.message,
    type: n.type,
    link: n.link ?? null,
  });
}
