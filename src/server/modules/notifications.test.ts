import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { notifications } from "@/db/schema";
import { createNotification } from "../lib/notifications";
import type { UserRow } from "../rpc/define";
import { callRpc, inRolledBackTx } from "../testing";

setDefaultTimeout(60_000);

type Wire = { _id: string; title: string; isRead: boolean; link?: string; type: string; _creationTime: number };

describe("notifications", () => {
  test("createNotification + get: newest first, capped at 50, wire shape", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      expect(await callRpc("notifications.get", {}, { user: null })).toEqual([]);

      const base = Date.now() - 100_000;
      await tx.insert(notifications).values(
        Array.from({ length: 55 }, (_, i) => ({ userId: user.id, title: `n${i}`, message: "m", type: "info" as const, createdAt: new Date(base + i * 1000) })),
      );
      await createNotification(tx, { userId: user.id, title: "newest", message: "hello", type: "success", link: "/queue" });

      const list = (await callRpc("notifications.get", {}, { user, tx })) as Wire[];
      expect(list.length).toBe(50);
      expect(list[0].title).toBe("newest");
      expect(list[0]).toMatchObject({ type: "success", isRead: false, link: "/queue" });
      expect(typeof list[0]._id).toBe("string");
      expect(typeof list[0]._creationTime).toBe("number");
      expect(list[1].title).toBe("n54");
      expect("link" in list[1]).toBe(false);
    });
  });

  test("markAsRead / markAllAsRead / clearAll only touch the caller's rows", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const stranger: UserRow = { ...user, id: randomUUID() }; // a different account (no rows)
      await createNotification(tx, { userId: user.id, title: "a", message: "m", type: "info" });
      await createNotification(tx, { userId: user.id, title: "b", message: "m", type: "warning" });
      const [a, b] = await tx.select().from(notifications).where(eq(notifications.userId, user.id));

      // ownership: another account cannot read, mark or clear them
      expect(await callRpc("notifications.get", {}, { user: stranger, tx })).toEqual([]);
      await expect(callRpc("notifications.markAsRead", { notificationId: a.id }, { user: stranger, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await callRpc("notifications.markAllAsRead", {}, { user: stranger, tx });
      await callRpc("notifications.clearAll", {}, { user: stranger, tx });
      let mine = await tx.select().from(notifications).where(eq(notifications.userId, user.id));
      expect(mine.length).toBe(2);
      expect(mine.every((n) => !n.isRead)).toBe(true);

      // unknown id
      await expect(callRpc("notifications.markAsRead", { notificationId: randomUUID() }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("notifications.markAsRead", { notificationId: "nope" }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });

      await callRpc("notifications.markAsRead", { notificationId: a.id }, { user, tx });
      mine = await tx.select().from(notifications).where(eq(notifications.userId, user.id));
      expect(mine.find((n) => n.id === a.id)?.isRead).toBe(true);
      expect(mine.find((n) => n.id === b.id)?.isRead).toBe(false);

      await callRpc("notifications.markAllAsRead", {}, { user, tx });
      mine = await tx.select().from(notifications).where(eq(notifications.userId, user.id));
      expect(mine.every((n) => n.isRead)).toBe(true);

      await callRpc("notifications.clearAll", {}, { user, tx });
      expect((await tx.select().from(notifications).where(eq(notifications.userId, user.id))).length).toBe(0);
    });
  });

  test("notifications cannot be created from the browser", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("notifications.createDummy", { title: "x", message: "y", type: "info" }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
